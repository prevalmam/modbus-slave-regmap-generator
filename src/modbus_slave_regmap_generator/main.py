import pandas as pd
import tkinter as tk
from tkinter import filedialog
import textwrap
import os
import re

try:
    from .utils import (
        cast_struct_value,
        extract_braced_value,
        format_array_init,
        generate_static_definition,
        get_base_type,
        get_read_func,
        get_type_size,
        get_write_func,
        map_access,
        map_type,
    )
except ImportError:  # pragma: no cover - fallback when running as a script
    from utils import (  # type: ignore
        cast_struct_value,
        extract_braced_value,
        format_array_init,
        generate_static_definition,
        get_base_type,
        get_read_func,
        get_type_size,
        get_write_func,
        map_access,
        map_type,
    )

BASE_FRAM_OFFSET = 0x0002

def main():
    root = tk.Tk()
    root.withdraw()
    file_path = filedialog.askopenfilename(filetypes=[("Excel files", "*.xlsx")])
    if not file_path:
        print("キャンセルされました")
        return

    reg_table_df = pd.read_excel(file_path, sheet_name="RegisterTable", header=None)
    lengthdefs_df = pd.read_excel(file_path, sheet_name="LengthDefs", header=None)
    config_df = pd.read_excel(file_path, sheet_name="Config", header=None)

    fram_total_size = int(config_df.iloc[4, 3])
    fram_offset_unused = fram_total_size

    length_defs = {}
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

    for i, row in reg_table_df.iterrows():
        if str(row[2]) == "Reg_Addr":
            header_row_index = i
            header_row = reg_table_df.iloc[i]

            # BR_列を検出する
            import re
            br_cols = {}
            for idx, col_name in enumerate(header_row):
                if isinstance(col_name, str) and col_name.startswith("BR_"):
                    key = col_name[3:]
                    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', key):
                        raise ValueError(f"Invalid BR_ column name: '{col_name}' is not a valid C identifier")
                    br_cols[key] = idx
            break

    entries = []
    fram_offset = BASE_FRAM_OFFSET

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

        entries.append({
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
            "var_type_str": var_type
        })

    h_text = textwrap.dedent("""\
        #ifndef MODBUS_REG_MAP_H
        #define MODBUS_REG_MAP_H

        #include <stdint.h>

        /* 配列長マクロ */
    """)
    for macro, val in length_defs.items():
        h_text += f"#define {macro} ({val}U)\n"

    h_text += textwrap.dedent(f"""
        /* FRAM サイズと無効オフセット */
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
    """)

    # ← busy_reject_flag_xxx を追加（正しいインデントで）
    if br_cols:
        for key in br_cols.keys():
            h_text += f"    uint8_t busy_reject_flag_{key};\n"

    # 正しい閉じと外部宣言
    h_text += textwrap.dedent("""\
        } reg_table_entry_t;

        extern const reg_table_entry_t g_reg_table[];
        extern const uint16_t g_reg_table_size;

        #endif
    """)

    # C89対応：modbus_reg_map.c の生成部分のみ抜粋修正版
    c_text = '#include "modbus_reg_map.h"\n\n'

    for e in entries:
        c_text += f"{e['ram_decl']}\n"

        value_type = e['ram_decl'].split()[1]  # 型名（static ... 型名 変数名...）から抽出
        count = e['length']        
        
        def extract_braced_value(value_str):
            m = re.search(r"\{([-+0-9.eE]+)f?\}", value_str)
            return m.group(1) if m else "0"

        vdef = extract_braced_value(e['default_value'])
        vmin = extract_braced_value(e['min_value'])
        vmax = extract_braced_value(e['max_value'])


        # value列から生成（動的）
        def_val = format_array_init(value_type, vdef, count)
        min_val = format_array_init(value_type, vmin, count)
        max_val = format_array_init(value_type, vmax, count)

        c_text += f"const {value_type} default_{e['name']}[{count}] = {{{def_val}}};\n"
        c_text += f"const {value_type} min_{e['name']}[{count}] = {{{min_val}}};\n"
        c_text += f"const {value_type} max_{e['name']}[{count}] = {{{max_val}}};\n"

    c_text += "\nconst reg_table_entry_t g_reg_table[] = {\n"
    for e in entries:
        c_text += "    {\n"
        c_text += f"        \"{e['name']}\",\n"
        c_text += f"        {e['modbus_addr']},\n"
        c_text += f"        {e['fram_offset']},\n"
        c_text += f"        {e['size']},\n"
        c_text += f"        default_{e['name']},\n"
        c_text += f"        min_{e['name']},\n"
        c_text += f"        max_{e['name']},\n"
        c_text += f"        {e['ram_ptr']},\n"
        c_text += f"        {e['type']},\n"
        c_text += f"        {e['length']},\n"
        c_text += f"        {e['access']},\n"

        br_keys = list(e['busy_reject_flags'].keys())
        for i, key in enumerate(br_keys):
            val = e['busy_reject_flags'][key]
            comma = ',' if i < len(br_keys) - 1 else ''
            c_text += f"        {val}{comma}\n"

        c_text += "    },\n"
    c_text += "};\n\n"
    c_text += "const uint16_t g_reg_table_size = (uint16_t)(sizeof(g_reg_table) / sizeof(g_reg_table[0]));\n"


    out_dir = os.path.dirname(file_path)
    with open(os.path.join(out_dir, "modbus_reg_map.h"), "w", encoding="utf-8") as f:
        f.write(h_text)
    with open(os.path.join(out_dir, "modbus_reg_map.c"), "w", encoding="utf-8") as f:
        f.write(c_text)

    idx_lines = ["#ifndef MODBUS_REG_IDX_H",
                 "#define MODBUS_REG_IDX_H",
                 "",
                 "#define MODBUS_SLAVE_ADDR 0x01",
                 "",                 
                 "/* Modbus register index definitions */"]

    # Add comments for modbus_reg_idx.h generation
    idx = 0
    for entry in entries:
        base_name = entry["name"]
        length = entry["length"]

        # ベースインデックス（g_reg_tableのインデックス）
        idx_lines.append(f"#define MODBUS_IDX_{base_name}  ({idx})")

        if length > 1:
            for i in range(length):
                idx_lines.append(f"#define MODBUS_IDX_{base_name}_{i}  ({i})")

        idx += 1  # ← g_reg_table[] の添字は1個分だけ進める

    idx_lines.append("")
    idx_lines.append("#endif")

    idx_text = "\n".join(idx_lines)
    with open(os.path.join(out_dir, "modbus_reg_idx.h"), "w", encoding="utf-8") as f:
        f.write(idx_text)

    # Generate modbus_reg_access.h
    # This file contains function prototypes for accessing Modbus registers.
    def get_base_type(entry_type):
        if "UINT16" in entry_type:
            return "uint16_t"
        elif "UINT32" in entry_type:
            return "uint32_t"
        elif "FLOAT" in entry_type:
            return "float"
        else:
            return "uint16_t"  # fallback

    access_lines = ["#ifndef MODBUS_REG_ACCESS_H",
                    "#define MODBUS_REG_ACCESS_H",
                    "",
                    "#include <stdint.h>",
                    "",
                    "/* Access function prototypes */"]

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

            # masked setter のプロトタイプも追加
            if base_type in ["uint16_t", "uint32_t"]:
                access_lines.append(f"int set_{base_name}_masked({base_type} mask, {base_type} value);")

        access_lines.append(f"{base_type} get_{base_name}_min(void);")
        access_lines.append(f"{base_type} get_{base_name}_max(void);")
        access_lines.append("")

    access_lines.append("#endif")

    access_text = "\n".join(access_lines)
    with open(os.path.join(out_dir, "modbus_reg_access.h"), "w", encoding="utf-8") as f:
        f.write(access_text)

    # Generate modbus_reg_access.c
    # This file contains the implementation of access functions for Modbus registers.

    used_types = {entry["var_type_str"] for entry in entries}

    access_c_lines = [
        '#include "modbus_reg_access.h"',
        '#include "modbus_reg_map.h"',
        '#include "modbus_reg_idx.h"',
        '',
        ]

    access_c_lines.extend([
        '/* Access function implementations */',
        '',
    ])    

    if "uint16_t" in used_types:
        access_c_lines.extend([            
        'static uint16_t read_uint16(const void *ptr) { return *((const uint16_t *)ptr); }',
        'static void write_uint16(void *ptr, uint16_t val) { *((uint16_t *)ptr) = val; }',
        ])
    if "uint32_t" in used_types:
        access_c_lines.extend([    
        'static uint32_t read_uint32(const void *ptr) { return *((const uint32_t *)ptr); }',
        'static void write_uint32(void *ptr, uint32_t val) { *((uint32_t *)ptr) = val; }',
        ])
    if "float" in used_types:
        access_c_lines.extend([    
        'static float    read_float (const void *ptr) { return *((const float    *)ptr); }',        
        'static void write_float (void *ptr, float    val) { *((float    *)ptr) = val; }',
        '',
        ])

    access_c_lines.extend([
        '/* Access function implementations */'
    ])    

    for idx, entry in enumerate(entries):
        name = entry["name"]
        base_type = get_base_type(entry["type"])
        read_func = get_read_func(entry["type"])
        write_func = get_write_func(entry["type"])
        is_array = entry["length"] > 1

        idx_macro = f"MODBUS_IDX_{name}"
        entry_ref = f"g_reg_table[{idx_macro}]"

        # get
        if is_array:
            access_c_lines.append(f"{base_type} get_{name}(uint16_t index)")
            access_c_lines.append("{")
            access_c_lines.append(f"    if (index >= {entry['length']}U) {{ return ({base_type})0; }}")
            access_c_lines.append(f"    return (({base_type} *)({entry_ref}.ram_ptr))[index];")
            access_c_lines.append("}")
        else:
            access_c_lines.append(f"{base_type} get_{name}(void)")
            access_c_lines.append("{")
            access_c_lines.append(f"    return {read_func}({entry_ref}.ram_ptr);")
            access_c_lines.append("}")

        # set
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
        
        access_c_lines.append(f"    if ((value < min) || (value > max))")
        access_c_lines.append("    {")
        access_c_lines.append("        return 0;")
        access_c_lines.append("    }")

        if is_array:
            access_c_lines.append(f"    (({base_type} *)({entry_ref}.ram_ptr))[index] = value;")
        else:
            access_c_lines.append(f"    {write_func}({entry_ref}.ram_ptr, value);")

        access_c_lines.append("    return 1;")
        access_c_lines.append("}")

        # min
        access_c_lines.append(f"{base_type} get_{name}_min(void)")
        access_c_lines.append("{")
        access_c_lines.append(f"    return {read_func}({entry_ref}.min_value);")
        access_c_lines.append("}")

        # max
        access_c_lines.append(f"{base_type} get_{name}_max(void)")
        access_c_lines.append("{")
        access_c_lines.append(f"    return {read_func}({entry_ref}.max_value);")
        access_c_lines.append("}")

        access_c_lines.append("")

            # masked setter の追加（uint16_t / uint32_t のみ）
        if base_type in ("uint16_t", "uint32_t") and not is_array:
            access_c_lines.append(f"int set_{name}_masked({base_type} mask, {base_type} value)")
            access_c_lines.append("{")
            access_c_lines.append(f"    {base_type} current = get_{name}();")
            access_c_lines.append(f"    value &= mask;  // mask外のbitは落とす")            
            access_c_lines.append(f"    current &= (uint16_t)(~mask);")
            access_c_lines.append(f"    current |= value;")
            access_c_lines.append(f"    return set_{name}(current);")
            access_c_lines.append("}")
            access_c_lines.append("")    

    with open(os.path.join(out_dir, "modbus_reg_access.c"), "w", encoding="utf-8") as f:
        f.write("\n".join(access_c_lines))

    
    # reg_edge.h
    edge_c_lines = [
        '#include "modbus_reg_access.h"',
        '#include "modbus_reg_idx.h"',
        '#include "modbus_reg_edge.h"',
        '',
    ]

    has_float = any("FLOAT" in entry["type"] for entry in entries)
    if has_float:
        edge_c_lines.extend([    
        '#define FLOAT_EPSILON (1.0e-6f)',
        '',
        'static int is_float_equal(float a, float b)',
        '{',
        '    float diff = a - b;',
        '    return (diff < FLOAT_EPSILON) && (diff > -FLOAT_EPSILON);',
        '}',
        '',
        ])
    edge_c_lines.extend([
        '/* Edge detection functions */'
    ])

    edge_h_lines = [
        '#ifndef MODBUS_REG_EDGE_H',
        '#define MODBUS_REG_EDGE_H',
        '',
        '#include <stdint.h>',
        ''
    ]

    # .hファイルにプロトタイプ追加（#endif の前）
    edge_h_lines.append("void modbus_reg_edge_init(void);")

    for entry in entries:
        name = entry["name"]
        base_type = get_base_type(entry["type"])
        is_array = entry["length"] > 1
        entry_type = entry["type"]

        # float単体
        if entry_type == "REG_TYPE_FLOAT" and not is_array:
            func = f"detect_{name}_changed"
            edge_h_lines.append(f"int {func}(void);")
            edge_c_lines.extend([
                f"int {func}(void)",
                "{",
                f"    static float prev;",  # ← 初期値を除去
                f"    float curr = get_{name}();",
                f"    if (!is_float_equal(prev, curr))",
                "    {",
                "        prev = curr;",
                "        return 1;",
                "    }",
                "    prev = curr;",
                "    return 0;",
                "}"
            ])

        # 整数単体
        elif entry_type in ("REG_TYPE_UINT16", "REG_TYPE_UINT32") and not is_array:
            for kind, condition in [
                ("rising", "((prev & bit_mask) == 0U) && ((curr & bit_mask) != 0U)"),
                ("falling", "((prev & bit_mask) != 0U) && ((curr & bit_mask) == 0U)"),
                ("toggled", "((prev ^ curr) & bit_mask) != 0U")
            ]:
                func = f"detect_{name}_{kind}"
                edge_h_lines.append(f"int {func}(uint16_t bit_mask);")
                edge_c_lines.extend([
                    f"int {func}(uint16_t bit_mask)",
                    "{",
                    f"    static {base_type} prev;",  # ← 初期値を除去
                    f"    {base_type} curr = get_{name}();",
                    f"    if ({condition})",
                    "    {",
                    "        prev = curr;",
                    "        return 1;",
                    "    }",
                    "    prev = curr;",
                    "    return 0;",
                    "}"
                ])

        # float配列
        elif entry_type == "REG_TYPE_FLOAT_ARRAY":
            # changed(index)
            func = f"detect_{name}_changed"
            edge_h_lines.append(f"int {func}(uint16_t index);")
            edge_c_lines.extend([
                f"int {func}(uint16_t index)",
                "{",
                f"    static float prev[{entry['length']}];",  # ← 初期化削除
                f"    float curr;",
                f"    if (index >= {entry['length']}U) return 0;",
                f"    curr = get_{name}(index);",
                f"    if (!is_float_equal(prev[index], curr))",
                "    {",
                "        prev[index] = curr;",
                "        return 1;",
                "    }",
                "    prev[index] = curr;",
                "    return 0;",
                "}"
            ])

            # any_changed()
            func = f"detect_{name}_any_changed"
            edge_h_lines.append(f"int {func}(void);")
            edge_c_lines.extend([
                f"int {func}(void)",
                "{",
                f"    static float prev[{entry['length']}];",  # ← 初期化削除
                f"    float curr;",
                "    uint16_t i;",
                f"    for (i = 0; i < {entry['length']}; ++i)",
                "    {",
                f"        curr = get_{name}(i);",
                f"        if (!is_float_equal(prev[i], curr))",
                "        {",
                "            prev[i] = curr;",
                "            return 1;",
                "        }",
                "        prev[i] = curr;",
                "    }",
                "    return 0;",
                "}"
            ])

        # 整数配列
        elif entry_type in ("REG_TYPE_UINT16_ARRAY", "REG_TYPE_UINT32_ARRAY"):
            for kind, condition in [
                ("rising", "((prev[index] & bit_mask) == 0U) && ((curr & bit_mask) != 0U)"),
                ("falling", "((prev[index] & bit_mask) != 0U) && ((curr & bit_mask) == 0U)"),
                ("toggled", "((prev[index] ^ curr) & bit_mask) != 0U")
            ]:
                func = f"detect_{name}_{kind}_edge"
                edge_h_lines.append(f"int {func}(uint16_t index, uint16_t bit_mask);")
                edge_c_lines.extend([
                    f"int {func}(uint16_t index, uint16_t bit_mask)",
                    "{",
                    f"    static {base_type} prev[{entry['length']}];",  # ← 初期化削除
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
                    "}"
                ])

            func = f"detect_{name}_any_changed"
            edge_h_lines.append(f"int {func}(void);")
            edge_c_lines.extend([
                f"int {func}(void)",
                "{",
                f"    static {base_type} prev[{entry['length']}];",  # ← 初期化削除
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
                "}"
            ])

    edge_h_lines.append("")

    def emit_edge_init_block():
        code_lines = []
        code_lines.append("void modbus_reg_edge_init(void)")
        code_lines.append("{")

            # 🔽 配列エントリが存在するかチェック
        has_array_entries = any(entry["length"] > 1 for entry in entries)

        if has_array_entries:
            code_lines.append("    uint16_t i = 0;")  # C89対応：ループ変数を冒頭に定義
        
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

    # init関数用コード追加
    edge_c_lines.append("")
    edge_c_lines.append(emit_edge_init_block())
    
    edge_h_lines.append("#endif")

    # 出力処理
    with open(os.path.join(out_dir, "modbus_reg_edge.c"), "w", encoding="utf-8") as f:
        f.write("\n".join(edge_c_lines))

    with open(os.path.join(out_dir, "modbus_reg_edge.h"), "w", encoding="utf-8") as f:
        f.write("\n".join(edge_h_lines))

    # 機能追加はここまで / End of additional functionality
    print("✅ ファイル出力完了:", out_dir)

if __name__ == "__main__":
    main()
