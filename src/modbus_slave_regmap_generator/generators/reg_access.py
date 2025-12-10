from __future__ import annotations

from typing import List, Set

from ..utils import get_base_type, get_read_func, get_write_func
from ..workbook_loader import WorkbookData
from . import GeneratedFile


def _collect_used_types(entries) -> Set[str]:
    return {entry["var_type_str"] for entry in entries}


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    entries = workbook.entries
    used_types = _collect_used_types(entries)

    access_lines = [
        "#ifndef MODBUS_REG_ACCESS_SLAVE_H",
        "#define MODBUS_REG_ACCESS_SLAVE_H",
        "",
        "#include <stdint.h>",
        "",
        "/* Access function prototypes */",
    ]

    for entry in entries:
        base_name = entry["name"]
        base_type = get_base_type(entry["type"])
        is_array = entry["length"] > 1

        if is_array:
            access_lines.append(f"{base_type} get_{base_name}(uint16_t index);")
            access_lines.append(f"int set_{base_name}(uint16_t index, {base_type} value);")
        else:
            access_lines.append(f"{base_type} get_{base_name}(void);")
            access_lines.append(f"int set_{base_name}({base_type} value);")

            if base_type in ["uint16_t", "uint32_t"]:
                access_lines.append(
                    f"int set_{base_name}_masked({base_type} mask, {base_type} value);"
                )

        access_lines.append(f"{base_type} get_{base_name}_min(void);")
        access_lines.append(f"{base_type} get_{base_name}_max(void);")
        access_lines.append("")

    access_lines.append("#endif")

    access_c_lines = [
        '#include "modbus_reg_access_slave.h"',
        '#include "modbus_reg_map_slave.h"',
        '#include "modbus_reg_idx_slave.h"',
        "",
        "/* Access function implementations */",
        "",
    ]

    if "uint16_t" in used_types:
        access_c_lines.extend(
            [
                "static uint16_t read_uint16(const void *ptr) { return *((const uint16_t *)ptr); }",
                "static void write_uint16(void *ptr, uint16_t val) { *((uint16_t *)ptr) = val; }",
            ]
        )
    if "uint32_t" in used_types:
        access_c_lines.extend(
            [
                "static uint32_t read_uint32(const void *ptr) { return *((const uint32_t *)ptr); }",
                "static void write_uint32(void *ptr, uint32_t val) { *((uint32_t *)ptr) = val; }",
            ]
        )
    if "float" in used_types:
        access_c_lines.extend(
            [
                "static float    read_float (const void *ptr) { return *((const float    *)ptr); }",
                "static void write_float (void *ptr, float    val) { *((float    *)ptr) = val; }",
                "",
            ]
        )

    access_c_lines.append("/* Access function implementations */")

    for entry in entries:
        name = entry["name"]
        base_type = get_base_type(entry["type"])
        read_func = get_read_func(entry["type"])
        write_func = get_write_func(entry["type"])
        is_array = entry["length"] > 1

        idx_macro = f"MODBUS_IDX_{name}"
        entry_ref = f"g_reg_table_slave[{idx_macro}]"

        if is_array:
            access_c_lines.append(f"{base_type} get_{name}(uint16_t index)")
            access_c_lines.append("{")
            access_c_lines.append(
                f"    if (index >= {entry['length']}U) {{ return ({base_type})0; }}"
            )
            access_c_lines.append(f"    return (({base_type} *)({entry_ref}.ram_ptr))[index];")
            access_c_lines.append("}")
        else:
            access_c_lines.append(f"{base_type} get_{name}(void)")
            access_c_lines.append("{")
            access_c_lines.append(f"    return {read_func}({entry_ref}.ram_ptr);")
            access_c_lines.append("}")

        if is_array:
            access_c_lines.append(f"int set_{name}(uint16_t index, {base_type} value)")
            access_c_lines.append("{")
            access_c_lines.append(f"    const {base_type} min = {read_func}({entry_ref}.min_value);")
            access_c_lines.append(f"    const {base_type} max = {read_func}({entry_ref}.max_value);")
            access_c_lines.append(f"    if (index >= {entry['length']}U) {{ return 0; }}")
        else:
            access_c_lines.append(f"int set_{name}({base_type} value)")
            access_c_lines.append("{")
            access_c_lines.append(f"    const {base_type} min = {read_func}({entry_ref}.min_value);")
            access_c_lines.append(f"    const {base_type} max = {read_func}({entry_ref}.max_value);")

        access_c_lines.append("    if ((value < min) || (value > max))")
        access_c_lines.append("    {")
        access_c_lines.append("        return 0;")
        access_c_lines.append("    }")

        if is_array:
            access_c_lines.append(f"    (({base_type} *)({entry_ref}.ram_ptr))[index] = value;")
        else:
            access_c_lines.append(f"    {write_func}({entry_ref}.ram_ptr, value);")

        access_c_lines.append("    return 1;")
        access_c_lines.append("}")

        access_c_lines.append(f"{base_type} get_{name}_min(void)")
        access_c_lines.append("{")
        access_c_lines.append(f"    return {read_func}({entry_ref}.min_value);")
        access_c_lines.append("}")

        access_c_lines.append(f"{base_type} get_{name}_max(void)")
        access_c_lines.append("{")
        access_c_lines.append(f"    return {read_func}({entry_ref}.max_value);")
        access_c_lines.append("}")
        access_c_lines.append("")

        if base_type in ("uint16_t", "uint32_t") and not is_array:
            access_c_lines.append(f"int set_{name}_masked({base_type} mask, {base_type} value)")
            access_c_lines.append("{")
            access_c_lines.append(f"    {base_type} current = get_{name}();")
            access_c_lines.append("    value &= mask;  // mask outside bits are cleared")
            access_c_lines.append("    current &= (uint16_t)(~mask);")
            access_c_lines.append("    current |= value;")
            access_c_lines.append(f"    return set_{name}(current);")
            access_c_lines.append("}")
            access_c_lines.append("")

    return [
        GeneratedFile("modbus_reg_access_slave.h", "\n".join(access_lines)),
        GeneratedFile("modbus_reg_access_slave.c", "\n".join(access_c_lines)),
    ]
