from __future__ import annotations

from typing import List

from ..workbook_loader import WorkbookData
from . import GeneratedFile


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    entries = [entry for entry in workbook.entries if entry["write_notify"]]

    header_lines = [
        "#ifndef MODBUS_REG_WRITE_EVENT_SLAVE_H",
        "#define MODBUS_REG_WRITE_EVENT_SLAVE_H",
        "",
        "#include <stdint.h>",
        "",
        "void modbus_reg_write_event_mark(uint16_t table_index);",
    ]
    source_lines = [
        '#include "modbus_reg_idx_slave.h"',
        '#include "modbus_reg_write_event_slave.h"',
        "",
    ]

    if entries:
        byte_count = (len(entries) + 7) // 8
        source_lines.append(f"static uint8_t s_written_bits[{byte_count}U];")
        source_lines.append("")

        for bit_index, entry in enumerate(entries):
            name = entry["name"]
            byte_index = bit_index // 8
            bit_mask = 1 << (bit_index % 8)
            header_lines.append(f"int consume_{name}_written(void);")
            source_lines.extend(
                [
                    f"int consume_{name}_written(void)",
                    "{",
                    f"    const uint8_t mask = 0x{bit_mask:02X}U;",
                    f"    const int written = (s_written_bits[{byte_index}U] & mask) != 0U;",
                    f"    s_written_bits[{byte_index}U] &= (uint8_t)(~mask);",
                    "    return written;",
                    "}",
                    "",
                ]
            )

        source_lines.extend(
            [
                "void modbus_reg_write_event_mark(uint16_t table_index)",
                "{",
                "    switch (table_index)",
                "    {",
            ]
        )
        for bit_index, entry in enumerate(entries):
            byte_index = bit_index // 8
            bit_mask = 1 << (bit_index % 8)
            source_lines.extend(
                [
                    f"        case MODBUS_IDX_{entry['name']}:",
                    f"            s_written_bits[{byte_index}U] |= 0x{bit_mask:02X}U;",
                    "            break;",
                ]
            )
        source_lines.extend(
            [
                "        default:",
                "            break;",
                "    }",
                "}",
            ]
        )
    else:
        source_lines.extend(
            [
                "void modbus_reg_write_event_mark(uint16_t table_index)",
                "{",
                "    (void)table_index;",
                "}",
            ]
        )

    header_lines.extend(["", "#endif"])

    return [
        GeneratedFile("modbus_reg_write_event_slave.c", "\n".join(source_lines)),
        GeneratedFile("modbus_reg_write_event_slave.h", "\n".join(header_lines)),
    ]
