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
    busy_reject_keys: List[str]
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

    br_cols: Dict[str, int] = {}
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
                (11, "EDGE"),
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

            for idx, col_name in enumerate(header_row):
                if isinstance(col_name, str) and col_name.startswith("BR_"):
                    key = col_name[3:]
                    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
                        raise ValueError(
                            f"Invalid BR_ column name: '{col_name}' is not a valid C identifier"
                        )
                    br_cols[key] = idx
            break
    else:
        raise ValueError("RegisterTable header row (Reg_Addr) not found")

    entries: List[dict] = []
    nvm_ranges: List[dict] = []
    reg_addr_records: List[dict] = []
    warnings: List[str] = []

    for i in range(header_row_index + 1, len(reg_table_df)):
        row = reg_table_df.iloc[i]
        if str(row[1]).strip().upper() == "EOF":
            break
        core_columns = row[2:10]
        if core_columns.isnull().all():
            continue

        edge_flag = row.iloc[11] if len(row) > 11 else None
        edge_enabled = _parse_bool_cell(edge_flag, "EDGE", i + 1)

        reg_addr, var_name, var_type, array_len, access, vmin, vmax, vdef = core_columns
        nvm_offset_cell = row.iloc[10] if len(row) > 10 else None
        if any(pd.isna(value) for value in (reg_addr, var_name, var_type, array_len, access)):
            continue

        var_name = str(var_name).strip()
        var_type = normalize_type(str(var_type).strip())
        array_len = str(array_len).strip()
        access = str(access).strip()
        string_type = is_string_type(var_type)

        is_array = True
        try:
            count = int(array_len)
            is_array = False
        except ValueError:
            if array_len not in length_defs:
                continue
            count = length_defs[array_len]

        modbus_addr = _parse_reg_addr_cell(reg_addr, i + 1, var_name)
        num_regs = (get_type_size(var_type) * count) // 2
        reg_addr_records.append(
            {"row": i + 1, "name": var_name, "addr": modbus_addr, "num_regs": num_regs}
        )

        if string_type:
            _validate_string_entry(
                row_number=i + 1,
                var_name=var_name,
                array_len=count,
                min_value=vmin,
                max_value=vmax,
                default_value=vdef,
                edge_enabled=edge_enabled,
            )
            is_array = False
            size_expr = f"sizeof(char) * {array_len}" if not array_len.isdigit() else f"sizeof(char) * {count}"
            vdef_str = "" if pd.isna(vdef) else str(vdef)
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

        br_flags = {
            key: "1U" if str(row[col_idx]).strip().upper() == "TRUE" else "0U"
            for key, col_idx in br_cols.items()
        }

        entries.append(
            {
                "name": var_name,
                "modbus_addr": modbus_addr,
                "nvm_offset": current_offset,
                "size": size_expr,
                "default_value": cast_struct_value(var_type, vdef, "default"),
                "min_value": cast_struct_value(var_type, vmin, "min"),
                "max_value": cast_struct_value(var_type, vmax, "max"),
                "ram_ptr": ram_ptr,
                "ram_decl": ram_decl,
                "type": map_type(var_type, is_array),
                "length": count,
                "access": map_access(access),
                "busy_reject_flags": br_flags,
                "var_type_str": var_type,
                "edge": edge_enabled,
            }
        )

    _validate_reg_addr_list(reg_addr_records)

    return WorkbookData(
        entries=entries,
        length_defs=length_defs,
        nvm_total_size=nvm_total_size,
        modbus_slave_addr=modbus_slave_addr,
        busy_reject_keys=list(br_cols.keys()),
        warnings=warnings,
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


def _validate_string_entry(
    *,
    row_number: int,
    var_name: str,
    array_len: int,
    min_value,
    max_value,
    default_value,
    edge_enabled: bool,
) -> None:
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
    if edge_enabled:
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: string EDGE must be FALSE."
        )
    if pd.isna(min_value) or str(min_value).strip() != "-":
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: string Min must be '-'."
        )
    if pd.isna(max_value) or str(max_value).strip() != "-":
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: string Max must be '-'."
        )

    default_text = "" if pd.isna(default_value) else str(default_value)
    if len(default_text) > (array_len - 1):
        raise ValueError(
            f"RegisterTable row {row_number} {var_name}: string Default length "
            f"must be {array_len - 1} bytes or less, got {len(default_text)}."
        )
    for ch in default_text:
        code = ord(ch)
        if code < 0x20 or code > 0x7E:
            raise ValueError(
                f"RegisterTable row {row_number} {var_name}: string Default "
                "must contain ASCII printable characters only."
            )


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

    normalized = str(value).strip().upper()
    if normalized == "TRUE":
        return True
    if normalized == "FALSE":
        return False

    raise ValueError(
        f"RegisterTable row {row_number}: {column_name} must be TRUE or FALSE, got '{value}'."
    )


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
