from __future__ import annotations

from typing import List

from ..utils import get_type_size
from ..workbook_loader import WorkbookData
from . import GeneratedFile


def _entry_register_count(entry: dict) -> int:
    return (get_type_size(entry["var_type_str"]) * entry["length"]) // 2


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    entries = sorted(
        (entry for entry in workbook.entries if entry["update_notify"]),
        key=lambda entry: entry["modbus_addr"],
    )

    header_lines = [
        "#ifndef MODBUS_REG_UPDATE_NOTIFY_SLAVE_H",
        "#define MODBUS_REG_UPDATE_NOTIFY_SLAVE_H",
        "",
        "#include <stdint.h>",
        "",
        "typedef enum",
        "{",
        "    MODBUS_REG_UPDATE_SOURCE_MASTER_WRITE = 1,",
        "    MODBUS_REG_UPDATE_SOURCE_INTERNAL_SET = 2",
        "} modbus_reg_update_source_t;",
        "",
        "void modbus_reg_update_notify_master_write(uint16_t start_addr,",
        "                                           uint16_t num_regs);",
        "void modbus_reg_update_notify_internal_set(uint16_t table_index);",
    ]
    source_lines = [
        '#include "modbus_reg_idx_slave.h"',
        '#include "modbus_reg_update_notify_slave.h"',
        "",
    ]

    for entry in entries:
        header_lines.extend(
            [
                "",
                f"extern void modbus_user_{entry['name']}_updated(",
                "    modbus_reg_update_source_t source);",
            ]
        )

    source_lines.extend(
        [
            "void modbus_reg_update_notify_master_write(uint16_t start_addr,",
            "                                           uint16_t num_regs)",
            "{",
        ]
    )
    if entries:
        source_lines.extend(
            [
                "    const uint32_t end_addr = (uint32_t)start_addr + num_regs;",
                "",
            ]
        )
        for entry in entries:
            entry_start = entry["modbus_addr"]
            entry_end = entry_start + _entry_register_count(entry)
            source_lines.extend(
                [
                    f"    if (((uint32_t)start_addr <= {entry_start}UL) &&",
                    f"        (end_addr >= {entry_end}UL))",
                    "    {",
                    f"        modbus_user_{entry['name']}_updated(",
                    "            MODBUS_REG_UPDATE_SOURCE_MASTER_WRITE);",
                    "    }",
                ]
            )
    else:
        source_lines.extend(
            [
                "    (void)start_addr;",
                "    (void)num_regs;",
            ]
        )
    source_lines.extend(
        [
            "}",
            "",
            "void modbus_reg_update_notify_internal_set(uint16_t table_index)",
            "{",
        ]
    )
    if entries:
        source_lines.extend(
            [
                "    switch (table_index)",
                "    {",
            ]
        )
        for entry in entries:
            source_lines.extend(
                [
                    f"        case MODBUS_IDX_{entry['name']}:",
                    f"            modbus_user_{entry['name']}_updated(",
                    "                MODBUS_REG_UPDATE_SOURCE_INTERNAL_SET);",
                    "            break;",
                ]
            )
        source_lines.extend(
            [
                "        default:",
                "            break;",
                "    }",
            ]
        )
    else:
        source_lines.append("    (void)table_index;")
    source_lines.append("}")

    header_lines.extend(["", "#endif"])

    return [
        GeneratedFile(
            "modbus_reg_update_notify_slave.c", "\n".join(source_lines)
        ),
        GeneratedFile(
            "modbus_reg_update_notify_slave.h", "\n".join(header_lines)
        ),
    ]
