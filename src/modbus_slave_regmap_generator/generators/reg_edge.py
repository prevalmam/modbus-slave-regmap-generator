from __future__ import annotations

from typing import List

from ..utils import get_base_type
from ..workbook_loader import WorkbookData
from . import GeneratedFile


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    entries = workbook.entries

    edge_c_lines = [
        '#include "modbus_reg_access_slave.h"',
        '#include "modbus_reg_idx_slave.h"',
        '#include "modbus_reg_edge_slave.h"',
        "",
    ]

    has_float = any("FLOAT" in entry["type"] for entry in entries)
    if has_float:
        edge_c_lines.extend(
            [
                "#define FLOAT_EPSILON (1.0e-6f)",
                "",
                "static int is_float_equal(float a, float b)",
                "{",
                "    float diff = a - b;",
                "    return (diff < FLOAT_EPSILON) && (diff > -FLOAT_EPSILON);",
                "}",
                "",
            ]
        )
    edge_c_lines.append("/* Edge detection functions */")

    edge_h_lines = [
        "#ifndef MODBUS_REG_EDGE_SLAVE_H",
        "#define MODBUS_REG_EDGE_SLAVE_H",
        "",
        "#include <stdint.h>",
        "",
        "void modbus_reg_edge_init(void);",
    ]

    for entry in entries:
        name = entry["name"]
        base_type = get_base_type(entry["type"])
        is_array = entry["length"] > 1
        entry_type = entry["type"]

        if entry_type == "REG_TYPE_FLOAT" and not is_array:
            func = f"detect_{name}_changed"
            edge_h_lines.append(f"int {func}(void);")
            edge_c_lines.extend(
                [
                    f"int {func}(void)",
                    "{",
                    "    static float prev;",
                    f"    float curr = get_{name}();",
                    "    if (!is_float_equal(prev, curr))",
                    "    {",
                    "        prev = curr;",
                    "        return 1;",
                    "    }",
                    "    prev = curr;",
                    "    return 0;",
                    "}",
                ]
            )

        if entry_type in ("REG_TYPE_UINT16", "REG_TYPE_UINT32") and not is_array:
            for kind, condition in [
                ("rising", "((prev & bit_mask) == 0U) && ((curr & bit_mask) != 0U)"),
                ("falling", "((prev & bit_mask) != 0U) && ((curr & bit_mask) == 0U)"),
                ("toggled", "((prev ^ curr) & bit_mask) != 0U"),
            ]:
                func = f"detect_{name}_{kind}"
                edge_h_lines.append(f"int {func}(uint16_t bit_mask);")
                edge_c_lines.extend(
                    [
                        f"int {func}(uint16_t bit_mask)",
                        "{",
                        f"    static {base_type} prev;",
                        f"    {base_type} curr = get_{name}();",
                        f"    if ({condition})",
                        "    {",
                        "        prev = curr;",
                        "        return 1;",
                        "    }",
                        "    prev = curr;",
                        "    return 0;",
                        "}",
                    ]
                )

        elif entry_type == "REG_TYPE_FLOAT_ARRAY":
            func = f"detect_{name}_changed"
            edge_h_lines.append(f"int {func}(uint16_t index);")
            edge_c_lines.extend(
                [
                    f"int {func}(uint16_t index)",
                    "{",
                    f"    static float prev[{entry['length']}];",
                    "    float curr;",
                    f"    if (index >= {entry['length']}U) return 0;",
                    f"    curr = get_{name}(index);",
                    "    if (!is_float_equal(prev[index], curr))",
                    "    {",
                    "        prev[index] = curr;",
                    "        return 1;",
                    "    }",
                    "    prev[index] = curr;",
                    "    return 0;",
                    "}",
                ]
            )

            func = f"detect_{name}_any_changed"
            edge_h_lines.append(f"int {func}(void);")
            edge_c_lines.extend(
                [
                    f"int {func}(void)",
                    "{",
                    f"    static float prev[{entry['length']}];",
                    "    float curr;",
                    "    uint16_t i;",
                    f"    for (i = 0; i < {entry['length']}; ++i)",
                    "    {",
                    f"        curr = get_{name}(i);",
                    "        if (!is_float_equal(prev[i], curr))",
                    "        {",
                    "            prev[i] = curr;",
                    "            return 1;",
                    "        }",
                    "        prev[i] = curr;",
                    "    }",
                    "    return 0;",
                    "}",
                ]
            )

        elif entry_type in ("REG_TYPE_UINT16_ARRAY", "REG_TYPE_UINT32_ARRAY"):
            for kind, condition in [
                ("rising", "((prev[index] & bit_mask) == 0U) && ((curr & bit_mask) != 0U)"),
                ("falling", "((prev[index] & bit_mask) != 0U) && ((curr & bit_mask) == 0U)"),
                ("toggled", "((prev[index] ^ curr) & bit_mask) != 0U"),
            ]:
                func = f"detect_{name}_{kind}_edge"
                edge_h_lines.append(f"int {func}(uint16_t index, uint16_t bit_mask);")
                edge_c_lines.extend(
                    [
                        f"int {func}(uint16_t index, uint16_t bit_mask)",
                        "{",
                        f"    static {base_type} prev[{entry['length']}];",
                        f"    {base_type} curr;",
                        f"    if (index >= {entry['length']}U) return 0;",
                        f"    curr = get_{name}(index);",
                        f"    if ({condition})",
                        "    {",
                        "        prev[index] = curr;",
                        "        return 1;",
                        "    }",
                        "    prev[index] = curr;",
                        "    return 0;",
                        "}",
                    ]
                )

            func = f"detect_{name}_any_changed"
            edge_h_lines.append(f"int {func}(void);")
            edge_c_lines.extend(
                [
                    f"int {func}(void)",
                    "{",
                    f"    static {base_type} prev[{entry['length']}];",
                    f"    {base_type} curr;",
                    "    uint16_t i;",
                    f"    for (i = 0; i < {entry['length']}; ++i)",
                    "    {",
                    f"        curr = get_{name}(i);",
                    "        if (curr != prev[i])",
                    "        {",
                    "            prev[i] = curr;",
                    "            return 1;",
                    "        }",
                    "        prev[i] = curr;",
                    "    }",
                    "    return 0;",
                    "}",
                ]
            )

    edge_h_lines.append("")
    edge_c_lines.append("")
    edge_c_lines.append(_emit_edge_init_block(entries))
    edge_h_lines.append("#endif")

    return [
        GeneratedFile("modbus_reg_edge_slave.c", "\n".join(edge_c_lines)),
        GeneratedFile("modbus_reg_edge_slave.h", "\n".join(edge_h_lines)),
    ]


def _emit_edge_init_block(entries) -> str:
    code_lines = []
    code_lines.append("void modbus_reg_edge_init(void)")
    code_lines.append("{")

    has_array_entries = any(entry["length"] > 1 for entry in entries)
    if has_array_entries:
        code_lines.append("    uint16_t i = 0;")
        code_lines.append("")

    for entry in entries:
        name = entry["name"]
        entry_type = entry["type"]
        is_array = entry["length"] > 1
        length = entry["length"]

        if entry_type == "REG_TYPE_FLOAT" and not is_array:
            code_lines.append(f"    (void)detect_{name}_changed();")
        elif entry_type in ("REG_TYPE_UINT16", "REG_TYPE_UINT32") and not is_array:
            for kind in ("rising", "falling", "toggled"):
                code_lines.append(f"    (void)detect_{name}_{kind}(0xFFFF);")
        elif entry_type == "REG_TYPE_FLOAT_ARRAY":
            code_lines.append(f"    for (i = 0; i < {length}U; ++i)")
            code_lines.append("    {")
            code_lines.append(f"        (void)detect_{name}_changed(i);")
            code_lines.append("    }")
            code_lines.append(f"    (void)detect_{name}_any_changed();")
        elif entry_type in ("REG_TYPE_UINT16_ARRAY", "REG_TYPE_UINT32_ARRAY"):
            for kind in ("rising", "falling", "toggled"):
                code_lines.append(f"    for (i = 0; i < {length}U; ++i)")
                code_lines.append("    {")
                code_lines.append(f"        (void)detect_{name}_{kind}_edge(i, 0xFFFF);")
                code_lines.append("    }")
            code_lines.append(f"    (void)detect_{name}_any_changed();")

    code_lines.append("}")
    return "\n".join(code_lines)
