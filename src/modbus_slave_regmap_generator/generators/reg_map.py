from __future__ import annotations

import textwrap
from typing import List

from ..utils import extract_braced_value, format_array_init
from ..workbook_loader import WorkbookData
from . import GeneratedFile


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    """Generate modbus_reg_map.[ch] contents."""
    entries = workbook.entries
    length_defs = workbook.length_defs
    fram_total_size = workbook.fram_total_size

    h_text = textwrap.dedent(
        """\
        #ifndef MODBUS_REG_MAP_H
        #define MODBUS_REG_MAP_H

        #include <stdint.h>

        /* Array length macros */
    """
    )
    for macro, val in length_defs.items():
        h_text += f"#define {macro} ({val}U)\n"

    h_text += textwrap.dedent(
        f"""
        /* FRAM size and unused offset */
        #define FRAM_TOTAL_SIZE     ({fram_total_size}U)
        #define FRAM_MAX_OFFSET     (FRAM_TOTAL_SIZE - 1U)
        #define FRAM_OFFSET_UNUSED  (FRAM_TOTAL_SIZE)

        typedef enum {{
            REG_TYPE_UINT16,
            REG_TYPE_UINT32,
            REG_TYPE_FLOAT,
            REG_TYPE_UINT16_ARRAY,
            REG_TYPE_UINT32_ARRAY,
            REG_TYPE_FLOAT_ARRAY
        }} reg_type_t;

        typedef enum {{
            ACCESS_READ,
            ACCESS_WRITE,
            ACCESS_READWRITE
        }} access_mode_t;

        typedef struct {{
            const char * name;
            uint16_t     modbus_addr;
            uint16_t     fram_offset;
            uint16_t     size;
            const void * default_value;
            const void * min_value;
            const void * max_value;
            void       * ram_ptr;
            reg_type_t   type;
            uint16_t     length;
            access_mode_t access;
    """
    )

    if workbook.busy_reject_keys:
        for key in workbook.busy_reject_keys:
            h_text += f"    uint8_t busy_reject_flag_{key};\n"

    h_text += textwrap.dedent(
        """\
        } reg_table_entry_t;

        extern const reg_table_entry_t g_reg_table[];
        extern const uint16_t g_reg_table_size;

        #endif
    """
    )

    c_text = '#include "modbus_reg_map.h"\n\n'
    for entry in entries:
        c_text += f"{entry['ram_decl']}\n"

        value_type = entry["ram_decl"].split()[1]
        count = entry["length"]

        vdef = extract_braced_value(entry["default_value"])
        vmin = extract_braced_value(entry["min_value"])
        vmax = extract_braced_value(entry["max_value"])

        def_val = format_array_init(value_type, vdef, count)
        min_val = format_array_init(value_type, vmin, count)
        max_val = format_array_init(value_type, vmax, count)

        c_text += f"const {value_type} default_{entry['name']}[{count}] = {{{def_val}}};\n"
        c_text += f"const {value_type} min_{entry['name']}[{count}] = {{{min_val}}};\n"
        c_text += f"const {value_type} max_{entry['name']}[{count}] = {{{max_val}}};\n"

    c_text += "\nconst reg_table_entry_t g_reg_table[] = {\n"
    for entry in entries:
        c_text += "    {\n"
        c_text += f"        \"{entry['name']}\",\n"
        c_text += f"        {entry['modbus_addr']},\n"
        c_text += f"        {entry['fram_offset']},\n"
        c_text += f"        {entry['size']},\n"
        c_text += f"        default_{entry['name']},\n"
        c_text += f"        min_{entry['name']},\n"
        c_text += f"        max_{entry['name']},\n"
        c_text += f"        {entry['ram_ptr']},\n"
        c_text += f"        {entry['type']},\n"
        c_text += f"        {entry['length']},\n"
        c_text += f"        {entry['access']},\n"

        br_keys = list(entry["busy_reject_flags"].keys())
        for i, key in enumerate(br_keys):
            val = entry["busy_reject_flags"][key]
            comma = "," if i < len(br_keys) - 1 else ""
            c_text += f"        {val}{comma}\n"

        c_text += "    },\n"
    c_text += "};\n\n"
    c_text += (
        "const uint16_t g_reg_table_size = "
        "(uint16_t)(sizeof(g_reg_table) / sizeof(g_reg_table[0]));\n"
    )

    return [
        GeneratedFile("modbus_reg_map.h", h_text),
        GeneratedFile("modbus_reg_map.c", c_text),
    ]
