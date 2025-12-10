from dataclasses import dataclass
from typing import Dict, List

import pandas as pd
import re

try:
    from .utils import (
        cast_struct_value,
        generate_static_definition,
        get_type_size,
        map_access,
        map_type,
    )
except ImportError:  # pragma: no cover - fallback when running as a script
    from utils import (  # type: ignore
        cast_struct_value,
        generate_static_definition,
        get_type_size,
        map_access,
        map_type,
    )


@dataclass
class WorkbookData:
    entries: List[dict]
    length_defs: Dict[str, int]
    fram_total_size: int
    modbus_slave_addr: int
    busy_reject_keys: List[str]


def load_workbook_data(file_path: str, base_fram_offset: int) -> WorkbookData:
    """Read Excel workbook and normalize register entries."""
    reg_table_df = pd.read_excel(file_path, sheet_name="RegisterTable", header=None)
    lengthdefs_df = pd.read_excel(file_path, sheet_name="LengthDefs", header=None)
    config_df = pd.read_excel(file_path, sheet_name="Config", header=None)

    fram_total_size = int(config_df.iloc[4, 3])

    modbus_slave_addr = None
    for _, row in config_df.iloc[4:].iterrows():  # start scan at Config!C5
        key = str(row[2]).strip().upper()
        if key == "SLAVE_ADDR":
            try:
                modbus_slave_addr = int(row[3])
            except (TypeError, ValueError) as exc:  # pragma: no cover - invalid Excel value
                raise ValueError("Config!D column SLAVE_ADDR must be an integer") from exc
            break

    if modbus_slave_addr is None:
        raise ValueError("Config!C column does not contain SLAVE_ADDR entry")

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
    fram_offset = base_fram_offset

    for i in range(header_row_index + 1, len(reg_table_df)):
        row = reg_table_df.iloc[i]
        if str(row[1]).strip().upper() == "EOF":
            break
        columns = row[2:11]
        if columns.isnull().any():
            continue

        reg_addr, var_name, var_type, array_len, access, vmin, vmax, vdef, fram_flag = columns
        var_name = str(var_name).strip()
        var_type = str(var_type).strip()
        array_len = str(array_len).strip()
        access = str(access).strip()

        is_array = True
        try:
            count = int(array_len)
            is_array = False
        except ValueError:
            if array_len not in length_defs:
                continue
            count = length_defs[array_len]

        size_expr = f"sizeof({var_type}) * {array_len}" if is_array else f"sizeof({var_type})"
        vdef_str = str(vdef).strip() if pd.notna(vdef) else "0"
        ram_decl = generate_static_definition(var_type, var_name, count, vdef_str)
        ram_ptr = f"{var_name}" if is_array else f"&{var_name}"

        if str(fram_flag).strip().upper() == "TRUE":
            total_bytes = get_type_size(var_type) * count
            current_offset = f"0x{fram_offset:04X}U"
            fram_offset += total_bytes
        else:
            current_offset = "FRAM_OFFSET_UNUSED"

        br_flags = {
            key: "1U" if str(row[col_idx]).strip().upper() == "TRUE" else "0U"
            for key, col_idx in br_cols.items()
        }

        entries.append(
            {
                "name": var_name,
                "modbus_addr": int(reg_addr),
                "fram_offset": current_offset,
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
            }
        )

    return WorkbookData(
        entries=entries,
        length_defs=length_defs,
        fram_total_size=fram_total_size,
        modbus_slave_addr=modbus_slave_addr,
        busy_reject_keys=list(br_cols.keys()),
    )
