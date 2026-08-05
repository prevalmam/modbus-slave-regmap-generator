from __future__ import annotations

from typing import List

from ..utils import get_base_type
from ..workbook_loader import WorkbookData
from . import GeneratedFile


def _write_check_declaration(entry: dict) -> List[str]:
    name = entry["name"]
    base_type = get_base_type(entry["type"])

    if entry["type"] == "REG_TYPE_STRING":
        return [
            f"extern modbus_write_result_t modbus_user_write_check_{name}(",
            "    const modbus_string_view_t *current_value,",
            "    const modbus_string_view_t *new_value);",
        ]
    if entry["is_array"]:
        return [
            f"extern modbus_write_result_t modbus_user_write_check_{name}(",
            f"    const {base_type} current_value[],",
            f"    const {base_type} new_value[],",
            "    uint16_t count);",
        ]
    return [
        f"extern modbus_write_result_t modbus_user_write_check_{name}(",
        f"    {base_type} current_value,",
        f"    {base_type} new_value);",
    ]


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    entries = [entry for entry in workbook.entries if entry["type"] != "REG_TYPE_RESERVED"]
    busy_entries = [entry for entry in entries if entry["busy_reject"]]
    checked_entries = [entry for entry in entries if entry["write_check"]]
    snapshot_entries = [entry for entry in entries if entry["group_validate"] is not None]

    h_lines = [
        "#ifndef MODBUS_REG_WRITE_GUARD_SLAVE_H",
        "#define MODBUS_REG_WRITE_GUARD_SLAVE_H",
        "",
        "#include <stdint.h>",
        "",
        "typedef uint8_t MB_BOOL;",
        "typedef uint8_t modbus_write_result_t;",
        "",
        "#define MB_FALSE ((MB_BOOL)0U)",
        "#define MB_TRUE  ((MB_BOOL)1U)",
        "",
        "#define MODBUS_WRITE_OK              ((modbus_write_result_t)0x00U)",
        "#define MODBUS_WRITE_ILLEGAL_ADDRESS ((modbus_write_result_t)0x02U)",
        "#define MODBUS_WRITE_ILLEGAL_VALUE   ((modbus_write_result_t)0x03U)",
        "#define MODBUS_WRITE_DEVICE_FAILURE  ((modbus_write_result_t)0x04U)",
        "#define MODBUS_WRITE_DEVICE_BUSY     ((modbus_write_result_t)0x06U)",
        "",
        "typedef struct",
        "{",
        "    const char *data;",
        "    uint16_t length;",
        "} modbus_string_view_t;",
        "",
        "typedef struct",
        "{",
    ]
    if snapshot_entries:
        for entry in snapshot_entries:
            if entry["type"] == "REG_TYPE_STRING":
                h_lines.append(f"    modbus_string_view_t {entry['name']};")
            else:
                base_type = get_base_type(entry["type"])
                h_lines.append(f"    const {base_type} *{entry['name']};")
    else:
        h_lines.append("    const uint8_t *unused;")
    h_lines.extend(
        [
            "} modbus_reg_snapshot_t;",
            "",
            "/* BUSY_REJECT accessors */",
        ]
    )

    for entry in busy_entries:
        name = entry["name"]
        h_lines.append(f"MB_BOOL modbus_get_busy_reject_{name}(void);")
        h_lines.append(f"void modbus_set_busy_reject_{name}(MB_BOOL busy);")
    if not busy_entries:
        h_lines.append("/* No BUSY_REJECT entries. */")

    h_lines.extend(["", "/* User-provided WRITE_CHECK callbacks */"])
    for entry in checked_entries:
        h_lines.extend(_write_check_declaration(entry))
    if not checked_entries:
        h_lines.append("/* No WRITE_CHECK callbacks. */")

    h_lines.extend(["", "/* User-provided GROUP_VALIDATE callbacks */"])
    for group_name in workbook.group_validate_names:
        h_lines.extend(
            [
                f"extern modbus_write_result_t modbus_user_group_validate_{group_name}(",
                "    const modbus_reg_snapshot_t *after);",
            ]
        )
    if not workbook.group_validate_names:
        h_lines.append("/* No GROUP_VALIDATE callbacks. */")

    h_lines.extend(
        [
            "",
            "MB_BOOL modbus_write_guard_entry_is_busy(uint16_t reg_table_index);",
            "",
            "#endif",
        ]
    )

    c_lines = [
        '#include "modbus_reg_write_guard_slave.h"',
        '#include "modbus_reg_idx_slave.h"',
        "",
    ]
    if busy_entries:
        byte_count = (len(busy_entries) + 7) // 8
        c_lines.append(f"static uint8_t s_busy_reject_bits[{byte_count}U];")
        c_lines.append("")

        for bit_index, entry in enumerate(busy_entries):
            name = entry["name"]
            byte_index = bit_index // 8
            bit_mask = 1 << (bit_index % 8)
            c_lines.extend(
                [
                    f"MB_BOOL modbus_get_busy_reject_{name}(void)",
                    "{",
                    f"    return ((s_busy_reject_bits[{byte_index}U] & 0x{bit_mask:02X}U) != 0U)",
                    "        ? MB_TRUE : MB_FALSE;",
                    "}",
                    "",
                    f"void modbus_set_busy_reject_{name}(MB_BOOL busy)",
                    "{",
                    "    if (busy != MB_FALSE)",
                    "    {",
                    f"        s_busy_reject_bits[{byte_index}U] |= 0x{bit_mask:02X}U;",
                    "    }",
                    "    else",
                    "    {",
                    f"        s_busy_reject_bits[{byte_index}U] &= (uint8_t)(~0x{bit_mask:02X}U);",
                    "    }",
                    "}",
                    "",
                ]
            )

    c_lines.extend(
        [
            "MB_BOOL modbus_write_guard_entry_is_busy(uint16_t reg_table_index)",
            "{",
            "    switch (reg_table_index)",
            "    {",
        ]
    )
    for entry in busy_entries:
        c_lines.extend(
            [
                f"        case MODBUS_IDX_{entry['name']}:",
                f"            return modbus_get_busy_reject_{entry['name']}();",
            ]
        )
    c_lines.extend(
        [
            "        default:",
            "            return MB_FALSE;",
            "    }",
            "}",
            "",
        ]
    )

    return [
        GeneratedFile("modbus_reg_write_guard_slave.h", "\n".join(h_lines) + "\n"),
        GeneratedFile("modbus_reg_write_guard_slave.c", "\n".join(c_lines) + "\n"),
    ]
