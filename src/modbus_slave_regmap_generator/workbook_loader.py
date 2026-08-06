from dataclasses import dataclass
from numbers import Integral, Real
from typing import Dict, List

import pandas as pd
import re

try:
    from .utils import (
        cast_struct_value,
        generate_static_definition,
        get_type_size,
        is_string_type,
        map_access,
        map_type,
        normalize_type,
    )
except ImportError:  # pragma: no cover - fallback when running as a script
    from utils import (  # type: ignore
        cast_struct_value,
        generate_static_definition,
        get_type_size,
        is_string_type,
        map_access,
        map_type,
        normalize_type,
    )


@dataclass
class WorkbookData:
    entries: List[dict]
    length_defs: Dict[str, int]
    nvm_total_size: int
    modbus_slave_addr: int
    group_validate_names: List[str]
    warnings: List[str]


def load_workbook_data(file_path: str) -> WorkbookData:
    """Read Excel workbook and normalize register entries."""
    reg_table_df = pd.read_excel(file_path, sheet_name="RegisterTable", header=None)
    lengthdefs_df = pd.read_excel(file_path, sheet_name="LengthDefs", header=None)
    config_df = pd.read_excel(file_path, sheet_name="Config", header=None)

    nvm_total_size = _read_config_int(config_df, "NVM_SIZE")
    _validate_nvm_total_size(nvm_total_size)
    modbus_slave_addr = _read_config_int(config_df, "SLAVE_ADDR")

    length_defs: Dict[str, int] = {}
    for _, row in lengthdefs_df.iterrows():
        if str(row[1]).strip().upper() == "EOF":
            break
        macro = row[2]
        value = row[3]
        if pd.notna(macro) and pd.notna(value):
            try:
                length_defs[str(macro).strip()] = int(value)
            except ValueError:
                continue

    for i, row in reg_table_df.iterrows():
        if str(row[2]) == "Reg_Addr":
            header_row_index = i
            header_row = reg_table_df.iloc[i]
            required_headers = [
                (2, "Reg_Addr"),
                (3, "VarName"),
                (4, "Type"),
                (5, "ArrayLen"),
                (6, "Access"),
                (7, "Min"),
                (8, "Max"),
                (9, "Default"),
                (10, "NVM_Offset"),
                (11, "UPDATE_NOTIFY"),
                (12, "BUSY_REJECT"),
                (13, "WRITE_CHECK"),
                (14, "GROUP_VALIDATE"),
            ]
            for col_idx, expected in required_headers:
                if col_idx >= len(header_row) or pd.isna(header_row.iloc[col_idx]):
                    actual = ""
                else:
                    actual = str(header_row.iloc[col_idx]).strip()
                if actual != expected:
                    excel_col = _excel_column_name(col_idx + 1)
                    raise ValueError(
                        f"RegisterTable header {excel_col}{header_row_index + 1}: "
                        f"expected '{expected}', got '{actual or '<empty>'}'"
                    )

            break
    else:
        raise ValueError("RegisterTable header row (Reg_Addr) not found")

    entries: List[dict] = []
    nvm_ranges: List[dict] = []
    reg_addr_records: List[dict] = []
    group_validate_names: List[str] = []
    warnings: List[str] = []

    for i in range(header_row_index + 1, len(reg_table_df)):
        row = reg_table_df.iloc[i]
        if str(row[1]).strip().upper() == "EOF":
            break
        core_columns = row[2:10]
        if core_columns.isnull().all():
            continue

        reg_addr, var_name, var_type_raw, array_len, access, vmin, vmax, vdef = core_columns
        nvm_offset_cell = row.iloc[10] if len(row) > 10 else None
        update_notify_cell = row.iloc[11] if len(row) > 11 else None
        busy_reject_cell = row.iloc[12] if len(row) > 12 else None
        write_check_cell = row.iloc[13] if len(row) > 13 else None
        group_validate_cell = row.iloc[14] if len(row) > 14 else None

        if any(pd.isna(value) for value in (reg_addr, var_name, var_type_raw, array_len)):
            continue

        var_name = str(var_name).strip()
        var_type = normalize_type(str(var_type_raw).strip())
        array_len = str(array_len).strip()

        # ── reserved エントリ ────────────────────────────────────────────
        if var_type == "reserved":
            update_notify_enabled = _parse_bool_cell(
                update_notify_cell, "UPDATE_NOTIFY", i + 1
            )
            busy_reject_enabled = _parse_bool_cell(
                busy_reject_cell, "BUSY_REJECT", i + 1
            )
            write_check_enabled = _parse_bool_cell(
                write_check_cell, "WRITE_CHECK", i + 1
            )
            group_validate = _parse_group_validate_cell(
                group_validate_cell, i + 1, var_name
            )
            _validate_reserved_columns(
                i + 1,
                var_name,
                access,
                vmin,
                vmax,
                vdef,
                nvm_offset_cell,
                update_notify_enabled,
                busy_reject_enabled,
                write_check_enabled,
                group_validate,
            )

            try:
                num_regs = int(array_len)
            except ValueError:
                raise ValueError(
                    f"RegisterTable row {i + 1} {var_name}: "
                    f"reserved ArrayLen must be a positive integer, got '{array_len}'."
                )
            if num_regs < 1:
                raise ValueError(
                    f"RegisterTable row {i + 1} {var_name}: "
                    f"reserved ArrayLen must be >= 1, got {num_regs}."
                )

            modbus_addr = _parse_reg_addr_cell(reg_addr, i + 1, var_name)
            reg_addr_records.append(
                {"row": i + 1, "name": var_name, "addr": modbus_addr, "num_regs": num_regs}
            )
            entries.append(
                {
                    "name": var_name,
                    "modbus_addr": modbus_addr,
                    "nvm_offset": "NVM_OFFSET_UNUSED",
                    "size": f"{num_regs * 2}U",
                    "default_value": "(const void *)0",
                    "min_value": "(const void *)0",
                    "max_value": "(const void *)0",
                    "ram_ptr": "(void *)0",
                    "ram_decl": None,
                    "type": "REG_TYPE_RESERVED",
                    "length": num_regs,
                    "access": "ACCESS_READ",
                    "var_type_str": "reserved",
                    "update_notify": False,
                    "is_array": False,
                    "busy_reject": False,
                    "write_check": False,
                    "group_validate": None,
                }
            )
            continue
        # ────────────────────────────────────────────────────────────────

        update_notify_enabled = _parse_bool_cell(
            update_notify_cell, "UPDATE_NOTIFY", i + 1
        )
        busy_reject_enabled = _parse_bool_cell(
            busy_reject_cell, "BUSY_REJECT", i + 1
        )
        write_check_enabled = _parse_bool_cell(
            write_check_cell, "WRITE_CHECK", i + 1
        )
        group_validate = _parse_group_validate_cell(
            group_validate_cell, i + 1, var_name
        )

        if any(pd.isna(value) for value in (access,)):
            continue

        access = str(access).strip()
        string_type = is_string_type(var_type)

        try:
            count = int(array_len)
        except ValueError:
            if array_len not in length_defs:
                continue
            count = length_defs[array_len]
        is_array = count > 1

        modbus_addr = _parse_reg_addr_cell(reg_addr, i + 1, var_name)
        num_regs = (get_type_size(var_type) * count) // 2
        reg_addr_records.append(
            {"row": i + 1, "name": var_name, "addr": modbus_addr, "num_regs": num_regs}
        )

        if string_type:
            vdef = _validate_string_entry(
                row_number=i + 1,
                var_name=var_name,
                array_len=count,
                min_value=vmin,
                max_value=vmax,
                default_value=vdef,
            )
            is_array = False
            size_expr = f"sizeof(char) * {array_len}" if not array_len.isdigit() else f"sizeof(char) * {count}"
            vdef_str = vdef
            ram_ptr = var_name
        else:
            if any(pd.isna(value) for value in (vmin, vmax, vdef)):
                continue
            size_expr = f"sizeof({var_type}) * {array_len}" if is_array else f"sizeof({var_type})"
            vdef_str = str(vdef).strip()
            ram_ptr = f"{var_name}" if is_array else f"&{var_name}"

        ram_decl = generate_static_definition(var_type, var_name, count, vdef_str)

        type_size = get_type_size(var_type)
        total_bytes = type_size * count
        current_offset = _parse_nvm_offset_cell(
            nvm_offset_cell,
            row_number=i + 1,
            var_name=var_name,
            total_bytes=total_bytes,
            type_size=type_size,
            nvm_total_size=nvm_total_size,
            nvm_ranges=nvm_ranges,
            warnings=warnings,
        )

        access_mode = map_access(access)
        if access_mode == "ACCESS_READ" and busy_reject_enabled:
            raise ValueError(
                f"RegisterTable row {i + 1} {var_name}: "
                "BUSY_REJECT must be FALSE for a read-only register."
            )
        if access_mode == "ACCESS_READ" and write_check_enabled:
            raise ValueError(
                f"RegisterTable row {i + 1} {var_name}: "
                "WRITE_CHECK must be FALSE for a read-only register."
            )
        if group_validate is not None and group_validate not in group_validate_names:
            group_validate_names.append(group_validate)

        entries.append(
            {
                "name": var_name,
                "modbus_addr": modbus_addr,
                "nvm_offset": current_offset,
                "size": size_expr,
                "default_value": (
                    vdef_str
                    if string_type
                    else cast_struct_value(var_type, vdef, "default")
                ),
                "min_value": cast_struct_value(var_type, vmin, "min"),
                "max_value": cast_struct_value(var_type, vmax, "max"),
                "ram_ptr": ram_ptr,
                "ram_decl": ram_decl,
                "type": map_type(var_type, is_array),
                "length": count,
                "access": access_mode,
                "var_type_str": var_type,
                "update_notify": update_notify_enabled,
                "is_array": is_array,
                "busy_reject": busy_reject_enabled,
                "write_check": write_check_enabled,
                "group_validate": group_validate,
            }
        )

    _validate_reg_addr_list(reg_addr_records)

    return WorkbookData(
        entries=entries,
        length_defs=length_defs,
        nvm_total_size=nvm_total_size,
        modbus_slave_addr=modbus_slave_addr,
        group_validate_names=group_validate_names,
        warnings=warnings,
    )


def _validate_reserved_columns(
    row_number: int,
    var_name: str,
    access,
    vmin,
    vmax,
    vdef,
    nvm_offset_cell,
    update_notify_enabled: bool,
    busy_reject_enabled: bool,
    write_check_enabled: bool,
    group_validate,
) -> None:
    for cell_val, col_name in [
        (access, "Access"),
        (vmin, "Min"),
        (vmax, "Max"),
        (vdef, "Default"),
        (nvm_offset_cell, "NVM_Offset"),
    ]:
        actual = "-" if pd.isna(cell_val) else str(cell_val).strip()
        if actual != "-":
            raise ValueError(
                f"RegisterTable row {row_number} {var_name}: "
                f"reserved {col_name} must be '-', got '{actual}'."
            )
    if update_notify_enabled:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            "reserved UPDATE_NOTIFY must be FALSE."
        )
    if busy_reject_enabled:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            "reserved BUSY_REJECT must be FALSE."
        )
    if write_check_enabled:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            "reserved WRITE_CHECK must be FALSE."
        )
    if group_validate is not None:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            "reserved GROUP_VALIDATE must be '-'."
        )


def _parse_reg_addr_cell(value, row_number: int, var_name: str) -> int:
    if isinstance(value, bool):
        _raise_invalid_reg_addr(value, row_number, var_name)

    if isinstance(value, Integral):
        addr = int(value)
    elif isinstance(value, Real):
        if not float(value).is_integer():
            _raise_invalid_reg_addr(value, row_number, var_name)
        addr = int(value)
    else:
        text = str(value).strip()
        if re.fullmatch(r"[0-9]+", text):
            addr = int(text)
        else:
            _raise_invalid_reg_addr(value, row_number, var_name)

    if addr < 0 or addr > 0xFFFF:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            f"Reg_Addr must be 0-65535, got {addr}."
        )
    return addr


def _raise_invalid_reg_addr(value, row_number: int, var_name: str) -> None:
    raise ValueError(
        f"RegisterTable row {row_number} {var_name}: "
        f"Reg_Addr must be a non-negative integer, got '{value}'."
    )


def _validate_reg_addr_list(records: List[dict]) -> None:
    for r in records:
        end = r["addr"] + r["num_regs"]
        if end > 0x10000:
            raise ValueError(
                f"RegisterTable row {r['row']} {r['name']}: "
                f"Reg_Addr 0x{r['addr']:04X} with {r['num_regs']} register(s) "
                f"ends at 0x{end - 1:04X}, exceeding the maximum Modbus address 0xFFFF."
            )

    sorted_recs = sorted(records, key=lambda r: r["addr"])
    for i, a in enumerate(sorted_recs):
        a_end = a["addr"] + a["num_regs"]
        for b in sorted_recs[i + 1:]:
            if b["addr"] >= a_end:
                break
            if b["addr"] == a["addr"]:
                raise ValueError(
                    f"RegisterTable row {b['row']} {b['name']}: "
                    f"Reg_Addr 0x{b['addr']:04X} is already used by "
                    f"row {a['row']} '{a['name']}'."
                )
            b_end = b["addr"] + b["num_regs"]
            raise ValueError(
                f"Register address overlap: "
                f"row {a['row']} '{a['name']}' [0x{a['addr']:04X}-0x{a_end - 1:04X}] "
                f"overlaps with row {b['row']} '{b['name']}' starting at 0x{b['addr']:04X}.\n"
                f"  row {a['row']} '{a['name']}': "
                f"Reg_Addr=0x{a['addr']:04X}, {a['num_regs']} register(s) "
                f"[0x{a['addr']:04X}-0x{a_end - 1:04X}]\n"
                f"  row {b['row']} '{b['name']}': "
                f"Reg_Addr=0x{b['addr']:04X}, {b['num_regs']} register(s) "
                f"[0x{b['addr']:04X}-0x{b_end - 1:04X}]"
            )


def _validate_nvm_total_size(nvm_total_size: int) -> None:
    if nvm_total_size < 1 or nvm_total_size > 0xFFFF:
        raise ValueError("Config NVM_SIZE must be between 1 and 65535.")


def _resolve_string_default(raw_value: str) -> str:
    """Resolve the authored Default cell into the literal string content.

    Bare '-' means "empty string". A dash wrapped in double quotes (e.g. '"-"')
    escapes that marker so a literal '-' can still be used as content.
    """
    if raw_value == "-":
        return ""
    if len(raw_value) >= 2 and raw_value.startswith('"') and raw_value.endswith('"'):
        return raw_value[1:-1]
    return raw_value


def _validate_string_entry(
    *,
    row_number: int,
    var_name: str,
    array_len: int,
    min_value,
    max_value,
    default_value,
) -> str:
    if array_len < 2:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            f"string ArrayLen must be at least 2, got {array_len}."
        )
    if (array_len % 2) != 0:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            f"string ArrayLen must be even, got {array_len}."
        )
    if pd.isna(min_value) or str(min_value).strip() != "-":
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: string Min must be '-'."
        )
    if pd.isna(max_value) or str(max_value).strip() != "-":
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: string Max must be '-'."
        )

    if pd.isna(default_value) or str(default_value).strip() == "":
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: string Default must not "
            "be blank. Use '-' for an empty string."
        )

    default_text = _resolve_string_default(str(default_value))
    if len(default_text) > array_len:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: string Default length "
            f"must be {array_len} bytes or less, got {len(default_text)}."
        )
    for ch in default_text:
        code = ord(ch)
        if code < 0x20 or code > 0x7E:
            raise ValueError(
                f"RegisterTable row {row_number} {var_name}: string Default "
                "must contain ASCII printable characters only."
            )
    return default_text


def _read_config_int(config_df: pd.DataFrame, key_name: str) -> int:
    for _, row in config_df.iloc[4:].iterrows():  # start scan at Config!C5
        key = str(row[2]).strip().upper()
        if key == key_name:
            try:
                return int(row[3])
            except (TypeError, ValueError) as exc:  # pragma: no cover - invalid Excel value
                raise ValueError(f"Config!D column {key_name} must be an integer") from exc

    raise ValueError(f"Config!C column does not contain {key_name} entry")


def _parse_bool_cell(value, column_name: str, row_number: int) -> bool:
    if pd.isna(value) or str(value).strip() == "":
        raise ValueError(
            f"RegisterTable row {row_number}: {column_name} is empty. Set TRUE or FALSE."
        )

    if isinstance(value, bool):
        return value

    normalized = str(value).strip()
    if normalized == "TRUE":
        return True
    if normalized == "FALSE":
        return False

    raise ValueError(
        f"RegisterTable row {row_number}: {column_name} must be TRUE or FALSE, got '{value}'."
    )


def _parse_group_validate_cell(value, row_number: int, var_name: str):
    if pd.isna(value) or str(value).strip() == "":
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            "GROUP_VALIDATE is empty. Set '-' or a group name."
        )

    text = str(value).strip()
    if text == "-":
        return None
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", text) is None:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            f"GROUP_VALIDATE must be '-' or a valid C identifier, got '{value}'."
        )
    return text.lower()


def _parse_nvm_offset_cell(
    value,
    *,
    row_number: int,
    var_name: str,
    total_bytes: int,
    type_size: int,
    nvm_total_size: int,
    nvm_ranges: List[dict],
    warnings: List[str],
) -> str:
    if pd.isna(value) or str(value).strip() == "":
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            "NVM_Offset is empty. Set '-' or an offset."
        )

    text = str(value).strip()
    if text == "-":
        return "NVM_OFFSET_UNUSED"

    offset = _parse_nvm_offset_value(value, row_number, var_name)
    end_offset = offset + total_bytes

    if offset == nvm_total_size:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: "
            f"NVM_Offset 0x{offset:04X} is reserved for NVM_OFFSET_UNUSED."
        )
    if end_offset > nvm_total_size:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: NVM range "
            f"[0x{offset:04X}, 0x{end_offset:04X}) exceeds NVM_SIZE "
            f"0x{nvm_total_size:04X}."
        )

    for existing in nvm_ranges:
        if offset < existing["end"] and existing["start"] < end_offset:
            raise ValueError(
                f"RegisterTable row {row_number} {var_name}: NVM range overlaps "
                f"with row {existing['row']} {existing['name']}.\n"
                f"  row {row_number} {var_name}: "
                f"[0x{offset:04X}, 0x{end_offset:04X})\n"
                f"  row {existing['row']} {existing['name']}: "
                f"[0x{existing['start']:04X}, 0x{existing['end']:04X})"
            )

    if type_size > 1 and offset % type_size != 0:
        warnings.append(
            f"RegisterTable row {row_number} {var_name}: "
            f"NVM_Offset 0x{offset:04X} is not aligned to {type_size} bytes."
        )

    nvm_ranges.append(
        {
            "row": row_number,
            "name": var_name,
            "start": offset,
            "end": end_offset,
        }
    )
    return f"0x{offset:04X}U"


def _parse_nvm_offset_value(value, row_number: int, var_name: str) -> int:
    if isinstance(value, bool):
        _raise_invalid_nvm_offset(value, row_number, var_name)

    if isinstance(value, Integral):
        offset = int(value)
    elif isinstance(value, Real) and not isinstance(value, bool):
        if not float(value).is_integer():
            _raise_invalid_nvm_offset(value, row_number, var_name)
        offset = int(value)
    else:
        text = str(value).strip()
        if re.fullmatch(r"0[xX][0-9A-Fa-f]+", text):
            offset = int(text, 16)
        elif re.fullmatch(r"[0-9]+", text):
            offset = int(text, 10)
        else:
            _raise_invalid_nvm_offset(value, row_number, var_name)

    if offset < 0:
        _raise_invalid_nvm_offset(value, row_number, var_name)
    return offset


def _raise_invalid_nvm_offset(value, row_number: int, var_name: str) -> None:
    raise ValueError(
        f"RegisterTable row {row_number} {var_name}: "
        f"NVM_Offset must be '-' or a decimal/0x-prefixed hexadecimal offset, got '{value}'."
    )


def _excel_column_name(column_number: int) -> str:
    name = ""
    while column_number > 0:
        column_number, remainder = divmod(column_number - 1, 26)
        name = chr(ord("A") + remainder) + name
    return name
