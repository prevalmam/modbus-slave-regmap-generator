from __future__ import annotations

from typing import List

from ..utils import get_base_type
from ..workbook_loader import WorkbookData
from . import GeneratedFile


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    entries = [entry for entry in workbook.entries if entry["edge"]]

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
            prev_name = f"s_prev_{name}_changed"
            func = f"detect_{name}_changed"
            sync_func = f"modbus_reg_edge_sync_{name}"
            edge_c_lines.append(f"static float {prev_name};")
            edge_h_lines.append(f"int {func}(void);")
            edge_h_lines.append(f"void {sync_func}(float value);")
            edge_c_lines.extend(
                [
                    f"int {func}(void)",
                    "{",
                    f"    float curr = get_{name}();",
                    f"    if (!is_float_equal({prev_name}, curr))",
                    "    {",
                    f"        {prev_name} = curr;",
                    "        return 1;",
                    "    }",
                    f"    {prev_name} = curr;",
                    "    return 0;",
                    "}",
                    "",
                    f"void {sync_func}(float value)",
                    "{",
                    f"    {prev_name} = value;",
                    "}",
                ]
            )

        if entry_type in ("REG_TYPE_UINT16", "REG_TYPE_UINT32") and not is_array:
            prev_names = {}
            for kind, condition in [
                (
                    "rising",
                    "(({prev} & bit_mask) == 0U) && ((curr & bit_mask) != 0U)",
                ),
                (
                    "falling",
                    "(({prev} & bit_mask) != 0U) && ((curr & bit_mask) == 0U)",
                ),
                ("toggled", "(({prev} ^ curr) & bit_mask) != 0U"),
            ]:
                prev_name = f"s_prev_{name}_{kind}"
                prev_names[kind] = prev_name
                func = f"detect_{name}_{kind}"
                edge_c_lines.append(f"static {base_type} {prev_name};")
                edge_h_lines.append(f"int {func}(uint16_t bit_mask);")
                edge_c_lines.extend(
                    [
                        f"int {func}(uint16_t bit_mask)",
                        "{",
                        f"    {base_type} curr = get_{name}();",
                        f"    if ({condition.format(prev=prev_name)})",
                        "    {",
                        f"        {prev_name} = curr;",
                        "        return 1;",
                        "    }",
                        f"    {prev_name} = curr;",
                        "    return 0;",
                        "}",
                    ]
                )
            sync_func = f"modbus_reg_edge_sync_{name}"
            edge_h_lines.append(f"void {sync_func}({base_type} value);")
            edge_c_lines.extend(
                [
                    f"void {sync_func}({base_type} value)",
                    "{",
                    f"    {prev_names['rising']} = value;",
                    f"    {prev_names['falling']} = value;",
                    f"    {prev_names['toggled']} = value;",
                    "}",
                ]
            )

        elif entry_type == "REG_TYPE_FLOAT_ARRAY":
            changed_prev_name = f"s_prev_{name}_changed"
            any_prev_name = f"s_prev_{name}_any_changed"
            func = f"detect_{name}_changed"
            edge_c_lines.append(
                f"static float {changed_prev_name}[{entry['length']}];"
            )
            edge_h_lines.append(f"int {func}(uint16_t index);")
            edge_c_lines.extend(
                [
                    f"int {func}(uint16_t index)",
                    "{",
                    "    float curr;",
                    f"    if (index >= {entry['length']}U) return 0;",
                    f"    curr = get_{name}(index);",
                    f"    if (!is_float_equal({changed_prev_name}[index], curr))",
                    "    {",
                    f"        {changed_prev_name}[index] = curr;",
                    "        return 1;",
                    "    }",
                    f"    {changed_prev_name}[index] = curr;",
                    "    return 0;",
                    "}",
                ]
            )

            func = f"detect_{name}_any_changed"
            edge_c_lines.append(f"static float {any_prev_name}[{entry['length']}];")
            edge_h_lines.append(f"int {func}(void);")
            edge_c_lines.extend(
                [
                    f"int {func}(void)",
                    "{",
                    "    float curr;",
                    "    uint16_t i;",
                    f"    for (i = 0; i < {entry['length']}; ++i)",
                    "    {",
                    f"        curr = get_{name}(i);",
                    f"        if (!is_float_equal({any_prev_name}[i], curr))",
                    "        {",
                    f"            {any_prev_name}[i] = curr;",
                    "            return 1;",
                    "        }",
                    f"        {any_prev_name}[i] = curr;",
                    "    }",
                    "    return 0;",
                    "}",
                ]
            )
            sync_func = f"modbus_reg_edge_sync_{name}"
            edge_h_lines.append(f"void {sync_func}(uint16_t index, float value);")
            edge_c_lines.extend(
                [
                    f"void {sync_func}(uint16_t index, float value)",
                    "{",
                    f"    if (index >= {entry['length']}U) return;",
                    f"    {changed_prev_name}[index] = value;",
                    f"    {any_prev_name}[index] = value;",
                    "}",
                ]
            )

        elif entry_type in ("REG_TYPE_UINT16_ARRAY", "REG_TYPE_UINT32_ARRAY"):
            prev_names = {}
            for kind, condition in [
                (
                    "rising",
                    "(({prev}[index] & bit_mask) == 0U) && ((curr & bit_mask) != 0U)",
                ),
                (
                    "falling",
                    "(({prev}[index] & bit_mask) != 0U) && ((curr & bit_mask) == 0U)",
                ),
                ("toggled", "(({prev}[index] ^ curr) & bit_mask) != 0U"),
            ]:
                prev_name = f"s_prev_{name}_{kind}"
                prev_names[kind] = prev_name
                func = f"detect_{name}_{kind}_edge"
                edge_c_lines.append(
                    f"static {base_type} {prev_name}[{entry['length']}];"
                )
                edge_h_lines.append(f"int {func}(uint16_t index, uint16_t bit_mask);")
                edge_c_lines.extend(
                    [
                        f"int {func}(uint16_t index, uint16_t bit_mask)",
                        "{",
                        f"    {base_type} curr;",
                        f"    if (index >= {entry['length']}U) return 0;",
                        f"    curr = get_{name}(index);",
                        f"    if ({condition.format(prev=prev_name)})",
                        "    {",
                        f"        {prev_name}[index] = curr;",
                        "        return 1;",
                        "    }",
                        f"    {prev_name}[index] = curr;",
                        "    return 0;",
                        "}",
                    ]
                )

            func = f"detect_{name}_any_changed"
            any_prev_name = f"s_prev_{name}_any_changed"
            edge_c_lines.append(
                f"static {base_type} {any_prev_name}[{entry['length']}];"
            )
            edge_h_lines.append(f"int {func}(void);")
            edge_c_lines.extend(
                [
                    f"int {func}(void)",
                    "{",
                    f"    {base_type} curr;",
                    "    uint16_t i;",
                    f"    for (i = 0; i < {entry['length']}; ++i)",
                    "    {",
                    f"        curr = get_{name}(i);",
                    f"        if (curr != {any_prev_name}[i])",
                    "        {",
                    f"            {any_prev_name}[i] = curr;",
                    "            return 1;",
                    "        }",
                    f"        {any_prev_name}[i] = curr;",
                    "    }",
                    "    return 0;",
                    "}",
                ]
            )
            sync_func = f"modbus_reg_edge_sync_{name}"
            edge_h_lines.append(
                f"void {sync_func}(uint16_t index, {base_type} value);"
            )
            edge_c_lines.extend(
                [
                    f"void {sync_func}(uint16_t index, {base_type} value)",
                    "{",
                    f"    if (index >= {entry['length']}U) return;",
                    f"    {prev_names['rising']}[index] = value;",
                    f"    {prev_names['falling']}[index] = value;",
                    f"    {prev_names['toggled']}[index] = value;",
                    f"    {any_prev_name}[index] = value;",
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
            code_lines.append(f"    for (i = 0; i < {length}U; ++i)")
            code_lines.append("    {")
            code_lines.append(f"        (void)detect_{name}_any_changed();")
            code_lines.append("    }")
        elif entry_type in ("REG_TYPE_UINT16_ARRAY", "REG_TYPE_UINT32_ARRAY"):
            for kind in ("rising", "falling", "toggled"):
                code_lines.append(f"    for (i = 0; i < {length}U; ++i)")
                code_lines.append("    {")
                code_lines.append(f"        (void)detect_{name}_{kind}_edge(i, 0xFFFF);")
                code_lines.append("    }")
            code_lines.append(f"    for (i = 0; i < {length}U; ++i)")
            code_lines.append("    {")
            code_lines.append(f"        (void)detect_{name}_any_changed();")
            code_lines.append("    }")

    code_lines.append("}")
    return "\n".join(code_lines)
