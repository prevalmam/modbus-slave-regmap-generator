const NVM_VALIDATION_SOURCE = String.raw`static uint8_t nvm_entry_is_valid(const reg_table_entry_t *entry)
{
    if (entry->nvm_offset == NVM_OFFSET_UNUSED) {
        return 0u;
    }
    if (entry->ram_ptr == (void *)0) {
        return 0u;
    }
    if (entry->size == 0u) {
        return 0u;
    }
    if (entry->nvm_offset >= (uint16_t)NVM_TOTAL_SIZE) {
        return 0u;
    }
    if (entry->size > (uint16_t)((uint16_t)NVM_TOTAL_SIZE - entry->nvm_offset)) {
        return 0u;
    }
    return 1u;
}

static uint8_t validate_u16_data(const reg_table_entry_t *entry,
                                                    const uint8_t *data)
{
    uint16_t i;
    uint16_t value;
    uint16_t min_value;
    uint16_t max_value;

    if ((entry->length == 0u) ||
        (entry->size != (uint16_t)(entry->length * (uint16_t)sizeof(uint16_t))) ||
        (entry->min_value == (const void *)0) ||
        (entry->max_value == (const void *)0)) {
        return 0u;
    }

    (void)memcpy(&min_value, entry->min_value, sizeof(min_value));
    (void)memcpy(&max_value, entry->max_value, sizeof(max_value));

    for (i = 0u; i < entry->length; i++) {
        (void)memcpy(&value, &data[(uint16_t)(i * (uint16_t)sizeof(uint16_t))], sizeof(value));
        if ((value < min_value) || (value > max_value)) {
            return 0u;
        }
    }

    return 1u;
}

static uint8_t validate_u32_data(const reg_table_entry_t *entry,
                                                    const uint8_t *data)
{
    uint16_t i;
    uint32_t value;
    uint32_t min_value;
    uint32_t max_value;

    if ((entry->length == 0u) ||
        (entry->size != (uint16_t)(entry->length * (uint16_t)sizeof(uint32_t))) ||
        (entry->min_value == (const void *)0) ||
        (entry->max_value == (const void *)0)) {
        return 0u;
    }

    (void)memcpy(&min_value, entry->min_value, sizeof(min_value));
    (void)memcpy(&max_value, entry->max_value, sizeof(max_value));

    for (i = 0u; i < entry->length; i++) {
        (void)memcpy(&value, &data[(uint16_t)(i * (uint16_t)sizeof(uint32_t))], sizeof(value));
        if ((value < min_value) || (value > max_value)) {
            return 0u;
        }
    }

    return 1u;
}

static uint8_t validate_float_data(const reg_table_entry_t *entry,
                                                      const uint8_t *data)
{
    uint16_t i;
    float value;
    float min_value;
    float max_value;

    if ((entry->length == 0u) ||
        (entry->size != (uint16_t)(entry->length * (uint16_t)sizeof(float))) ||
        (entry->min_value == (const void *)0) ||
        (entry->max_value == (const void *)0)) {
        return 0u;
    }

    (void)memcpy(&min_value, entry->min_value, sizeof(min_value));
    (void)memcpy(&max_value, entry->max_value, sizeof(max_value));

    for (i = 0u; i < entry->length; i++) {
        (void)memcpy(&value, &data[(uint16_t)(i * (uint16_t)sizeof(float))], sizeof(value));
        if (value != value) {
            return 0u;
        }
        if ((value < min_value) || (value > max_value)) {
            return 0u;
        }
    }

    return 1u;
}

static uint8_t validate_string_data(const reg_table_entry_t *entry,
                                                       const uint8_t *data)
{
    if ((entry->size == 0u) ||
        (entry->length != entry->size)) {
        return 0u;
    }

    return (modbus_string_field_is_valid((const char *)data,
                                         entry->size) != 0)
        ? 1u
        : 0u;
}

static uint8_t nvm_data_is_valid(const reg_table_entry_t *entry,
                                                    const uint8_t *data)
{
    if ((entry == (const reg_table_entry_t *)0) || (data == (const uint8_t *)0)) {
        return 0u;
    }

    switch (entry->type) {
    case REG_TYPE_UINT16:
    case REG_TYPE_UINT16_ARRAY:
        return validate_u16_data(entry, data);

    case REG_TYPE_UINT32:
    case REG_TYPE_UINT32_ARRAY:
        return validate_u32_data(entry, data);

    case REG_TYPE_FLOAT:
    case REG_TYPE_FLOAT_ARRAY:
        return validate_float_data(entry, data);

    case REG_TYPE_STRING:
        return validate_string_data(entry, data);

    default:
        break;
    }

    return 0u;
}
`;

function generateNvm(project: RegmapDocument, entries: readonly GeneratorEntry[]): GeneratedFiles {
  const groups = project.resetGroupDefs ?? [];
  const header = `#ifndef MODBUS_REG_NVM_SLAVE_H
#define MODBUS_REG_NVM_SLAVE_H

#include <stdint.h>

typedef enum {
${groups.map(group => "    MODBUS_RESET_GROUP_" + group.id.toUpperCase() + ",").join("\n")}
    MODBUS_RESET_GROUP_COUNT
} modbus_reset_group_t;

typedef enum {
    MODBUS_RESET_OK = 0,
    MODBUS_RESET_INVALID_GROUP
} modbus_reset_result_t;

typedef enum {
    MODBUS_NVM_CAPTURE_UNCHANGED = 0,
    MODBUS_NVM_CAPTURE_CAPTURED,
    MODBUS_NVM_CAPTURE_INVALID_ARG,
    MODBUS_NVM_CAPTURE_BUFFER_TOO_SMALL
} modbus_nvm_capture_result_t;

typedef enum {
    MODBUS_NVM_RESTORE_OK = 0,
    MODBUS_NVM_RESTORE_REPAIRED,
    MODBUS_NVM_RESTORE_INVALID_ARG,
    MODBUS_NVM_RESTORE_SIZE_MISMATCH
} modbus_nvm_restore_result_t;

/* Call these APIs in one execution context, outside compound RAM updates. */
/* Boot preparation; does not request saving. */
void modbus_reg_load_defaults(void);
/* Successful INIT always requests saving, including unchanged/RAM-only values. */
modbus_reset_result_t modbus_reg_reset_defaults(modbus_reset_group_t group);
void modbus_reg_nvm_mark_dirty(void);
/* Synchronous copy into caller-owned storage; consumes dirty only on success. */
modbus_nvm_capture_result_t modbus_reg_nvm_capture_if_changed(
    uint8_t *dst, uint16_t capacity);
/* Exact-size image; invalid entries use their defaults and request saving. */
modbus_nvm_restore_result_t modbus_reg_nvm_restore(
    const uint8_t *src, uint16_t size);

#endif /* MODBUS_REG_NVM_SLAVE_H */
`;
  const members = groups.map(group => entries.filter(entry => entry.resetGroups.includes(group.id)));
  const declarations = members.map((items, i) => items.length ?
    `static const uint16_t s_reset_group_${i}[] = {\n${items.map(entry => "    " + indexMacro(entry) + ",").join("\n")}\n};\n` : "").join("\n");
  const cases = groups.map((group, i) => `    case MODBUS_RESET_GROUP_${group.id.toUpperCase()}:
        indices = ${members[i].length ? "s_reset_group_" + i : "(const uint16_t *)0"};
        count = ${members[i].length}U;
        break;`).join("\n");
  const withEnums = entries.some(entry => entry.definition);
  const enumValidation = withEnums ? `
        if ((valid != 0U) && (entry->type == REG_TYPE_UINT16) && (entry->length == 1U)) {
            (void)memcpy(&raw, data, sizeof(raw));
            valid = (uint8_t)modbus_reg_enum_wire_value_is_valid(i, raw);
        }` : "";
  const source = `#include "modbus_reg_nvm_slave.h"
#include "modbus_reg_map_slave_internal.h"
#include "modbus_reg_idx_slave.h"
${withEnums ? ENUM_INTERNAL_INCLUDE + "\n" : ""}#include <string.h>

static uint8_t s_nvm_dirty = 0U;

${declarations}
${NVM_VALIDATION_SOURCE}
void modbus_reg_nvm_mark_dirty(void)
{
    s_nvm_dirty = 1U;
}

void modbus_reg_load_defaults(void)
{
    uint16_t i;
    const reg_table_entry_t *entry;

    for (i = 0U; i < g_reg_table_slave_size; ++i) {
        entry = &g_reg_table_slave[i];
        if ((entry->ram_ptr != (void *)0) && (entry->default_value != (const void *)0)) {
            (void)memcpy(entry->ram_ptr, entry->default_value, entry->size);
        }
    }
}

modbus_reset_result_t modbus_reg_reset_defaults(modbus_reset_group_t group)
{
    const uint16_t *indices;
    uint16_t count;
    uint16_t i;
    const reg_table_entry_t *entry;

    switch (group) {
${cases}
    default:
        return MODBUS_RESET_INVALID_GROUP;
    }
    for (i = 0U; i < count; ++i) {
        entry = &g_reg_table_slave[indices[i]];
        (void)memcpy(entry->ram_ptr, entry->default_value, entry->size);
    }
    modbus_reg_nvm_mark_dirty();
    return MODBUS_RESET_OK;
}

modbus_nvm_capture_result_t modbus_reg_nvm_capture_if_changed(
    uint8_t *dst, uint16_t capacity)
{
    uint16_t i;
    const reg_table_entry_t *entry;

    if (dst == (uint8_t *)0) {
        return MODBUS_NVM_CAPTURE_INVALID_ARG;
    }
    if (capacity < (uint16_t)NVM_TOTAL_SIZE) {
        return MODBUS_NVM_CAPTURE_BUFFER_TOO_SMALL;
    }
    if (s_nvm_dirty == 0U) {
        return MODBUS_NVM_CAPTURE_UNCHANGED;
    }
    (void)memset(dst, 0xFF, (uint16_t)NVM_TOTAL_SIZE);
    for (i = 0U; i < g_reg_table_slave_size; ++i) {
        entry = &g_reg_table_slave[i];
        if (nvm_entry_is_valid(entry) != 0U) {
            (void)memcpy(&dst[entry->nvm_offset], entry->ram_ptr, entry->size);
        }
    }
    s_nvm_dirty = 0U;
    return MODBUS_NVM_CAPTURE_CAPTURED;
}

modbus_nvm_restore_result_t modbus_reg_nvm_restore(
    const uint8_t *src, uint16_t size)
{
    uint16_t i;
${withEnums ? "    uint16_t raw;\n" : ""}    uint8_t repaired = 0U;
    uint8_t valid;
    const reg_table_entry_t *entry;
    const uint8_t *data;

    if (src == (const uint8_t *)0) {
        return MODBUS_NVM_RESTORE_INVALID_ARG;
    }
    if (size != (uint16_t)NVM_TOTAL_SIZE) {
        return MODBUS_NVM_RESTORE_SIZE_MISMATCH;
    }
    for (i = 0U; i < g_reg_table_slave_size; ++i) {
        entry = &g_reg_table_slave[i];
        if (nvm_entry_is_valid(entry) == 0U) {
            continue;
        }
        data = &src[entry->nvm_offset];
        valid = nvm_data_is_valid(entry, data);${enumValidation}
        if (valid != 0U) {
            (void)memcpy(entry->ram_ptr, data, entry->size);
        } else {
            (void)memcpy(entry->ram_ptr, entry->default_value, entry->size);
            repaired = 1U;
        }
    }
    s_nvm_dirty = repaired;
    return repaired != 0U ? MODBUS_NVM_RESTORE_REPAIRED : MODBUS_NVM_RESTORE_OK;
}
`;
  return {"modbus_reg_nvm_slave.h": header, "modbus_reg_nvm_slave.c": source};
}
