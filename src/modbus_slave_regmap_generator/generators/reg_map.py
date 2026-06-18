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
    nvm_total_size = workbook.nvm_total_size

    h_text = textwrap.dedent(
        """\
        #ifndef MODBUS_REG_MAP_SLAVE_H
        #define MODBUS_REG_MAP_SLAVE_H

        #include <stdint.h>

        /* Array length macros */
    """
    )
    for macro, val in length_defs.items():
        h_text += f"#define {macro} ({val}U)\n"

    h_text += textwrap.dedent(
        f"""
        /* NVM size and unused offset */
        #define NVM_TOTAL_SIZE     ({nvm_total_size}U)
        #define NVM_MAX_OFFSET     (NVM_TOTAL_SIZE - 1U)
        #define NVM_OFFSET_UNUSED  (NVM_TOTAL_SIZE)

        typedef enum {{
            REG_TYPE_UINT16,
            REG_TYPE_UINT32,
            REG_TYPE_FLOAT,
            REG_TYPE_STRING,
            REG_TYPE_UINT16_ARRAY,
            REG_TYPE_UINT32_ARRAY,
            REG_TYPE_FLOAT_ARRAY,
            REG_TYPE_RESERVED
        }} reg_type_t;

        typedef enum {{
            ACCESS_READ,
            ACCESS_WRITE,
            ACCESS_READWRITE
        }} access_mode_t;

        typedef struct {{
            const char * name;
            uint16_t     modbus_addr;
            uint16_t     nvm_offset;
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

    h_text += textwrap.dedent(
        """\
        } reg_table_entry_t;

        extern const reg_table_entry_t g_reg_table_slave[];
        extern const uint16_t g_reg_table_slave_size;

        #endif
    """
    )

    c_text = '#include "modbus_reg_map_slave.h"\n\n'
    for entry in entries:
        if entry["type"] == "REG_TYPE_RESERVED":
            continue

        c_text += f"{entry['ram_decl']}\n"

        if entry["type"] == "REG_TYPE_STRING":
            c_text += f"const char default_{entry['name']}[{entry['length']}] = {entry['default_value']};\n"
            continue

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

    c_text += "\nconst reg_table_entry_t g_reg_table_slave[] = {\n"
    for entry in entries:
        c_text += "    {\n"
        c_text += f"        \"{entry['name']}\",\n"
        c_text += f"        {entry['modbus_addr']},\n"
        c_text += f"        {entry['nvm_offset']},\n"
        c_text += f"        {entry['size']},\n"
        if entry["type"] == "REG_TYPE_RESERVED":
            c_text += "        (const void *)0,\n"
            c_text += "        (const void *)0,\n"
            c_text += "        (const void *)0,\n"
        elif entry["type"] == "REG_TYPE_STRING":
            c_text += f"        default_{entry['name']},\n"
            c_text += "        (const void *)0,\n"
            c_text += "        (const void *)0,\n"
        else:
            c_text += f"        default_{entry['name']},\n"
            c_text += f"        min_{entry['name']},\n"
            c_text += f"        max_{entry['name']},\n"
        c_text += f"        {entry['ram_ptr']},\n"
        c_text += f"        {entry['type']},\n"
        c_text += f"        {entry['length']},\n"
        c_text += f"        {entry['access']},\n"

        c_text += "    },\n"
    c_text += "};\n\n"
    c_text += (
        "const uint16_t g_reg_table_slave_size = "
        "(uint16_t)(sizeof(g_reg_table_slave) / sizeof(g_reg_table_slave[0]));\n"
    )

    return [
        GeneratedFile("modbus_reg_map_slave.h", h_text),
        GeneratedFile("modbus_reg_map_slave.c", c_text),
    ]
