from __future__ import annotations

from typing import List, Set

from ..utils import get_base_type, get_read_func, get_write_func
from ..workbook_loader import WorkbookData
from . import GeneratedFile


def _collect_used_types(entries) -> Set[str]:
    return {entry["var_type_str"] for entry in entries if entry["type"] != "REG_TYPE_RESERVED"}


def _is_string_entry(entry) -> bool:
    return entry["type"] == "REG_TYPE_STRING"


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    entries = workbook.entries
    used_types = _collect_used_types(entries)
    has_string = any(_is_string_entry(entry) for entry in entries)

    access_lines = [
        "#ifndef MODBUS_REG_ACCESS_SLAVE_H",
        "#define MODBUS_REG_ACCESS_SLAVE_H",
        "",
        "#include <stdint.h>",
        "",
        "/* Access constants and function prototypes */",
    ]

    for entry in entries:
        if entry["type"] == "REG_TYPE_RESERVED":
            continue
        base_name = entry["name"]
        if _is_string_entry(entry):
            access_lines.append(
                f"#define MODBUS_{base_name}_MAX_LENGTH  ({entry['length']}U)"
            )
            access_lines.append(
                f"#define MODBUS_{base_name}_BUFFER_SIZE "
                f"(MODBUS_{base_name}_MAX_LENGTH + 1U)"
            )
            access_lines.append(
                f"int get_{base_name}_copy(char *dst, uint16_t dst_size);"
            )
            access_lines.append(f"int set_{base_name}(const char *value);")
            access_lines.append("")
            continue

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
    ]
    if has_string:
        access_c_lines.append("#include <string.h>")
    access_c_lines.extend(
        [
        "",
        "extern void NVM_Request_Write_Bytes(uint16_t offset,",
        "                                    const uint8_t *data,",
        "                                    uint16_t length);",
        "",
        "/* Access function implementations */",
        "",
        "static void write_nvm_if_used(uint16_t offset, const void *data, uint16_t length)",
        "{",
        "    if (offset != NVM_OFFSET_UNUSED)",
        "    {",
        "        NVM_Request_Write_Bytes(offset, (const uint8_t *)data, length);",
        "    }",
        "}",
        "",
        ]
    )

    if has_string:
        access_c_lines.extend(
            [
                "static uint16_t string_length_limited(const char *value, uint16_t max_size)",
                "{",
                "    uint16_t len = 0U;",
                "",
                "    if (value == (const char *)0)",
                "    {",
                "        return max_size;",
                "    }",
                "",
                "    while ((len < max_size) && (value[len] != '\\0'))",
                "    {",
                "        ++len;",
                "    }",
                "    return len;",
                "}",
                "",
                "static int is_valid_string_value(const char *value, uint16_t max_chars)",
                "{",
                "    uint16_t i;",
                "    unsigned char ch;",
                "",
                "    if ((value == (const char *)0) || (max_chars == 0U))",
                "    {",
                "        return 0;",
                "    }",
                "",
                "    for (i = 0U; i < max_chars; ++i)",
                "    {",
                "        ch = (unsigned char)value[i];",
                "        if (ch == '\\0')",
                "        {",
                "            return 1;",
                "        }",
                "        if ((ch < 0x20U) || (ch > 0x7EU))",
                "        {",
                "            return 0;",
                "        }",
                "    }",
                "",
                "    return value[max_chars] == '\\0';",
                "}",
                "",
            ]
        )

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
        if entry["type"] == "REG_TYPE_RESERVED":
            continue
        name = entry["name"]
        if _is_string_entry(entry):
            idx_macro = f"MODBUS_IDX_{name}"
            entry_ref = f"g_reg_table_slave[{idx_macro}]"
            length = entry["length"]

            access_c_lines.append(f"int get_{name}_copy(char *dst, uint16_t dst_size)")
            access_c_lines.append("{")
            access_c_lines.append(f"    const char *src = (const char *)({entry_ref}.ram_ptr);")
            access_c_lines.append(
                f"    const uint16_t len = modbus_string_field_length(src, {length}U);"
            )
            access_c_lines.append("")
            access_c_lines.append("    if ((dst == (char *)0) || (dst_size <= len))")
            access_c_lines.append("    {")
            access_c_lines.append("        return 0;")
            access_c_lines.append("    }")
            access_c_lines.append("")
            access_c_lines.append("    (void)memcpy(dst, src, len);")
            access_c_lines.append("    dst[len] = '\\0';")
            access_c_lines.append("    return 1;")
            access_c_lines.append("}")
            access_c_lines.append("")

            access_c_lines.append(f"int set_{name}(const char *value)")
            access_c_lines.append("{")
            access_c_lines.append(f"    char temp[{length}];")
            access_c_lines.append(f"    char * const ram = (char *)({entry_ref}.ram_ptr);")
            access_c_lines.append(
                f"    const uint16_t len = string_length_limited(value, {length + 1}U);"
            )
            access_c_lines.append("")
            access_c_lines.append(f"    if (is_valid_string_value(value, {length}U) == 0)")
            access_c_lines.append("    {")
            access_c_lines.append("        return 0;")
            access_c_lines.append("    }")
            access_c_lines.append("")
            access_c_lines.append("    (void)memset(temp, 0, sizeof(temp));")
            access_c_lines.append("    (void)memcpy(temp, value, len);")
            access_c_lines.append("")
            access_c_lines.append("    if (memcmp(ram, temp, sizeof(temp)) == 0)")
            access_c_lines.append("    {")
            access_c_lines.append("        return 1;")
            access_c_lines.append("    }")
            access_c_lines.append("")
            access_c_lines.append("    (void)memcpy(ram, temp, sizeof(temp));")
            access_c_lines.append(
                f"    write_nvm_if_used({entry_ref}.nvm_offset, ram, {entry_ref}.size);"
            )
            access_c_lines.append("    return 1;")
            access_c_lines.append("}")
            access_c_lines.append("")
            continue

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
            access_c_lines.append(f"    {base_type} * const ram = ({base_type} *)({entry_ref}.ram_ptr);")
            access_c_lines.append(f"    {base_type} current;")
            access_c_lines.append("    uint16_t nvm_offset;")
            access_c_lines.append(f"    if (index >= {entry['length']}U) {{ return 0; }}")
        else:
            access_c_lines.append(f"int set_{name}({base_type} value)")
            access_c_lines.append("{")
            access_c_lines.append(f"    const {base_type} min = {read_func}({entry_ref}.min_value);")
            access_c_lines.append(f"    const {base_type} max = {read_func}({entry_ref}.max_value);")
            access_c_lines.append(f"    const {base_type} current = {read_func}({entry_ref}.ram_ptr);")

        access_c_lines.append("    if ((value < min) || (value > max))")
        access_c_lines.append("    {")
        access_c_lines.append("        return 0;")
        access_c_lines.append("    }")
        access_c_lines.append("")

        if is_array:
            access_c_lines.append("    current = ram[index];")

        access_c_lines.append("    if (value == current)")
        access_c_lines.append("    {")
        access_c_lines.append("        return 1;")
        access_c_lines.append("    }")

        if is_array:
            access_c_lines.append("    ram[index] = value;")
            access_c_lines.append(f"    if ({entry_ref}.nvm_offset != NVM_OFFSET_UNUSED)")
            access_c_lines.append("    {")
            access_c_lines.append(
                f"        nvm_offset = (uint16_t)({entry_ref}.nvm_offset + "
                f"(uint16_t)(index * sizeof({base_type})));"
            )
            access_c_lines.append(
                "        write_nvm_if_used(nvm_offset, &ram[index], "
                "(uint16_t)sizeof(value));"
            )
            access_c_lines.append("    }")
        else:
            access_c_lines.append(f"    {write_func}({entry_ref}.ram_ptr, value);")
            access_c_lines.append(
                f"    write_nvm_if_used({entry_ref}.nvm_offset, {entry_ref}.ram_ptr, "
                "(uint16_t)sizeof(value));"
            )

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
            access_c_lines.append("    value &= mask;  /* mask outside bits are cleared */")
            access_c_lines.append(f"    current &= ({base_type})(~mask);")
            access_c_lines.append("    current |= value;")
            access_c_lines.append(f"    return set_{name}(current);")
            access_c_lines.append("}")
            access_c_lines.append("")

    return [
        GeneratedFile("modbus_reg_access_slave.h", "\n".join(access_lines)),
        GeneratedFile("modbus_reg_access_slave.c", "\n".join(access_c_lines)),
    ]
