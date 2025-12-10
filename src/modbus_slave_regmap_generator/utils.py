import re
from typing import Any


def format_value_for_init(var_type: str, value: str) -> str:
    """Format a scalar for static initialization (adds suffixes where needed)."""
    try:
        if value.strip() == "":
            value = "0"
        if var_type == "float":
            fval = float(value)
            return f"{int(fval)}.0f" if fval.is_integer() else f"{fval}f"
        if var_type == "uint16_t":
            return f"{int(value)}U"
        if var_type == "uint32_t":
            return f"{int(value)}UL"
        return value
    except Exception:
        return "0"


def generate_static_definition(var_type: str, var_name: str, count: int, default_str: str) -> str:
    """Create a static C definition for RAM mirrors (scalar or array)."""
    init_val = format_value_for_init(var_type, default_str)
    if count == 1:
        return f"static {var_type} {var_name} = {init_val};"
    init_list = ", ".join([init_val] * count)
    return f"static {var_type} {var_name}[{count}] = {{{init_list}}};"


def get_type_size(var_type_str: str) -> int:
    """Return byte size of supported Modbus register types."""
    if var_type_str == "uint16_t":
        return 2
    if var_type_str in ("uint32_t", "float"):
        return 4
    return 2


def map_type(var_type: str, is_array: bool) -> str:
    """Map register type to enum constant used in generated C code."""
    if var_type == "uint16_t":
        return "REG_TYPE_UINT16_ARRAY" if is_array else "REG_TYPE_UINT16"
    if var_type == "uint32_t":
        return "REG_TYPE_UINT32_ARRAY" if is_array else "REG_TYPE_UINT32"
    if var_type == "float":
        return "REG_TYPE_FLOAT_ARRAY" if is_array else "REG_TYPE_FLOAT"
    return "REG_TYPE_UINT16"


def map_access(access_str: str) -> str:
    """Normalize access string from Excel to enum constant."""
    s = str(access_str).strip().upper()
    if s == "R":
        return "ACCESS_READ"
    if s == "W":
        return "ACCESS_WRITE"
    if s == "RW":
        return "ACCESS_READWRITE"
    return "ACCESS_READWRITE"


def format_array_init(var_type: str, value: str, count: int) -> str:
    """Expand a scalar initializer across an array for generated tables."""
    val_str = format_value_for_init(var_type, value)
    return ", ".join([val_str] * count)


def format_scalar_value(var_type: str, value: Any) -> str:
    """Format scalar values used inside compound literals."""
    if var_type == "float":
        try:
            fval = float(value)
            return f"{int(fval)}.0f" if fval.is_integer() else f"{fval}f"
        except (ValueError, TypeError):
            return "0.0f"
    return "0" if value is None else str(value)


def cast_struct_value(var_type: str, value: Any, kind: str) -> str:
    """Wrap value as addressable compound literal for reg table struct fields."""
    if var_type == "float":
        value_str = "" if value is None else str(value).strip()
        if kind == "min" and value_str == "":
            return "&(float){-3.4e+38f}"
        if kind == "max" and value_str == "":
            return "&(float){3.4e+38f}"
    formatted = format_scalar_value(var_type, value)
    return f"&({var_type}){{{formatted}}}"


def extract_braced_value(value_str: str) -> str:
    """Extract scalar literal inside a compound literal string."""
    match = re.search(r"\{([-+0-9.eE]+)f?\}", value_str)
    return match.group(1) if match else "0"


def get_base_type(entry_type: str) -> str:
    """Convert enum-based register types to primitive C types."""
    if "UINT16" in entry_type:
        return "uint16_t"
    if "UINT32" in entry_type:
        return "uint32_t"
    if "FLOAT" in entry_type:
        return "float"
    return "uint16_t"


def get_read_func(entry_type: str) -> str:
    """Select helper read function name for accessor generation."""
    if "UINT16" in entry_type:
        return "read_uint16"
    if "UINT32" in entry_type:
        return "read_uint32"
    if "FLOAT" in entry_type:
        return "read_float"
    return "read_uint16"


def get_write_func(entry_type: str) -> str:
    """Select helper write function name for accessor generation."""
    if "UINT16" in entry_type:
        return "write_uint16"
    if "UINT32" in entry_type:
        return "write_uint32"
    if "FLOAT" in entry_type:
        return "write_float"
    return "write_uint16"
