/* C fragments ported from the Python generator at 327684e. Whitespace is part of the trace. */

const REGMAP_HEADER = String.raw`#ifndef MODBUS_REG_MAP_SLAVE_H
#define MODBUS_REG_MAP_SLAVE_H

#include <stdint.h>

/* Array length macros */
@LENGTH_DEFS@
/* NVM size and unused offset */
#define NVM_TOTAL_SIZE     (@NVM_SIZE@U)
#define NVM_MAX_OFFSET     (NVM_TOTAL_SIZE - 1U)
#define NVM_OFFSET_UNUSED  (NVM_TOTAL_SIZE)

/* Maximum byte size of one NVM-backed register entry. */
#define NVM_MAX_ENTRY_SIZE_BYTES (@NVM_MAX_ENTRY_SIZE_BYTES@U)

#endif
`;

const REGMAP_INTERNAL_HEADER = String.raw`#ifndef MODBUS_REG_MAP_SLAVE_INTERNAL_H
#define MODBUS_REG_MAP_SLAVE_INTERNAL_H

/* Generated implementation only. Application code uses the public APIs. */
#include "modbus_reg_map_slave.h"

typedef enum {
    REG_TYPE_UINT16,
    REG_TYPE_UINT32,
    REG_TYPE_FLOAT,
    REG_TYPE_STRING,
    REG_TYPE_UINT16_ARRAY,
    REG_TYPE_UINT32_ARRAY,
    REG_TYPE_FLOAT_ARRAY,
    REG_TYPE_RESERVED
} reg_type_t;

typedef enum {
    ACCESS_READ,
    ACCESS_WRITE,
    ACCESS_READWRITE
} access_mode_t;

typedef struct {
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
} reg_table_entry_t;

extern const reg_table_entry_t g_reg_table_slave[];
extern const uint16_t g_reg_table_slave_size;

uint16_t modbus_string_field_length(const char *data,
                                    uint16_t field_size);
int modbus_string_field_is_valid(const char *data,
                                 uint16_t field_size);

#endif
`;

const REGMAP_FOOTER = String.raw`const uint16_t g_reg_table_slave_size = (uint16_t)(sizeof(g_reg_table_slave) / sizeof(g_reg_table_slave[0]));


uint16_t modbus_string_field_length(const char *data,
                                    uint16_t field_size)
{
    uint16_t length = 0U;

    if (data == (const char *)0)
    {
        return 0U;
    }
    while ((length < field_size) && (data[length] != '\0'))
    {
        ++length;
    }
    return length;
}

int modbus_string_field_is_valid(const char *data,
                                 uint16_t field_size)
{
    uint16_t i;
    int found_nul = 0;
    unsigned char ch;

    if ((data == (const char *)0) || (field_size == 0U))
    {
        return 0;
    }
    for (i = 0U; i < field_size; ++i)
    {
        ch = (unsigned char)data[i];
        if (found_nul != 0)
        {
            if (ch != 0U)
            {
                return 0;
            }
        }
        else if (ch == 0U)
        {
            found_nul = 1;
        }
        else if ((ch < 0x20U) || (ch > 0x7EU))
        {
            return 0;
        }
        else
        {
            /* ASCII printable character. */
        }
    }
    return 1;
}
`;

const ACCESS_HEADER_START = String.raw`#ifndef MODBUS_REG_ACCESS_SLAVE_H
#define MODBUS_REG_ACCESS_SLAVE_H

#include <stdint.h>

/* Access constants and function prototypes */`;

const ACCESS_SOURCE_START = String.raw`#include "modbus_reg_access_slave.h"
#include "modbus_reg_map_slave_internal.h"
#include "modbus_reg_idx_slave.h"
#include "modbus_reg_update_notify_slave.h"
#include "modbus_reg_nvm_slave.h"`;

const ACCESS_NVM_HELPER = String.raw`
/* Access function implementations */

static void write_nvm_if_used(uint16_t offset, const void *data, uint16_t length)
{
    (void)data;
    (void)length;
    if (offset != NVM_OFFSET_UNUSED)
    {
        modbus_reg_nvm_mark_dirty();
    }
}
`;

const ACCESS_STRING_HELPERS = String.raw`static uint16_t string_length_limited(const char *value, uint16_t max_size)
{
    uint16_t len = 0U;

    if (value == (const char *)0)
    {
        return max_size;
    }

    while ((len < max_size) && (value[len] != '\0'))
    {
        ++len;
    }
    return len;
}

static int is_valid_string_value(const char *value, uint16_t max_chars)
{
    uint16_t i;
    unsigned char ch;

    if ((value == (const char *)0) || (max_chars == 0U))
    {
        return 0;
    }

    for (i = 0U; i < max_chars; ++i)
    {
        ch = (unsigned char)value[i];
        if (ch == '\0')
        {
            return 1;
        }
        if ((ch < 0x20U) || (ch > 0x7EU))
        {
            return 0;
        }
    }

    return value[max_chars] == '\0';
}
`;

const PARSER_HEADER = String.raw`/*
 * modbus_parser.h
 *
 *  Created on: 2025/05/22
 *      Author: 1225190
 */

#ifndef MODBUSLAYER_MODBUS_PARSER_H_
#define MODBUSLAYER_MODBUS_PARSER_H_

#include <stdint.h>

#define MODBUS_EXCEPTION_SLAVE_DEVICE_BUSY  (0x06U)

extern void ModbusPort_RequestSend(const uint8_t *frame, uint16_t length);

/* Implement in handwritten code. Return nonzero to accept the address. */
uint8_t modbus_user_accept_slave_address(uint8_t address);

void modbus_send_exception_response(uint8_t slave_addr, uint8_t function_code, uint8_t exception_code);
void modbus_parse_and_reply(const uint8_t *rx_buf, uint16_t len);

#endif /* MODBUSLAYER_MODBUS_PARSER_H_ */
`;

const PARSER_SOURCE = String.raw`#include "modbus_parser.h"
@ENUM_INCLUDE@
#include "modbus_reg_map_slave_internal.h"
#include "modbus_reg_idx_slave.h"
#include "modbus_reg_update_notify_slave.h"
#include "modbus_reg_nvm_slave.h"
#include "modbus_reg_write_guard_slave.h"
#include <string.h>

/* Function Codes */
#define MODBUS_FUNC_READ_HOLDING_REGS      (0x03U)
#define MODBUS_FUNC_WRITE_SINGLE_REG       (0x06U)
#define MODBUS_FUNC_DIAGNOSTICS            (0x08U)
#define MODBUS_FUNC_WRITE_MULTIPLE_REGS    (0x10U)

/* Diagnostics Sub-function Codes */
#define MODBUS_DIAG_SUBFUNC_RETURN_QUERY   (0x0000U)

/* Exception Codes */
#define MODBUS_EXC_ILLEGAL_FUNCTION        (0x01U)
#define MODBUS_EXC_ILLEGAL_DATA_ADDRESS    (0x02U)
#define MODBUS_EXC_ILLEGAL_DATA_VALUE      (0x03U)
#define MODBUS_EXC_SLAVE_DEVICE_FAILURE    (0x04U)

/* Protocol Constants */
#define MODBUS_MIN_FRAME_LENGTH            (8U)  /* addr + func + data + CRC */
#define MODBUS_MAX_FRAME_LENGTH            (256U)
#define MODBUS_SINGLE_REG_DATA_LENGTH      (4U)  /* 2 bytes address + 2 bytes data */
#define MODBUS_WRITE_MULTI_HEADER_LENGTH   (7U)  /* 7 = addr(1) + func(1) + start(2) + count(2) + byte count(1) */

#define MODBUS_REG_SIZE_BYTES    (2U)
#define MODBUS_MAX_DATA_LENGTH   (252U)

#define MAX_MATCHED_ENTRIES 256U

#define FLOAT_EPSILON (1.0e-6f)

static int check_range_float(float val, float min, float max);
static int check_range_uint16(uint16_t val, uint16_t min, uint16_t max);
static int check_range_uint32(uint32_t val, uint32_t min, uint32_t max);


static void modbus_send_write_single_ack(uint8_t slave_addr, uint16_t addr, const uint8_t *value);

static int is_float_equal(float a, float b);

static void modbus_send_echo_response(uint8_t slave_addr, const uint8_t *rx_buf, uint16_t len);
static void modbus_send_write_multi_ack(uint8_t slave_addr, uint16_t start_addr, uint16_t num_regs);
static int handle_modbus_multi_write(uint16_t start_addr, uint16_t num_regs, const uint8_t *data);
static int modbus_validate_crc(const uint8_t* frame, uint16_t length);

static uint16_t modbus_append_crc(uint8_t* frame, uint16_t len_without_crc);
int handle_modbus_read(uint8_t slave_addr, uint16_t start_addr, uint16_t num_regs);

static void sort_entries_by_address(const reg_table_entry_t *matched[], uint16_t count);

int is_float_equal(float a, float b)
{
    float diff = a - b;
    return (diff < FLOAT_EPSILON) && (diff > -FLOAT_EPSILON);
}

void sort_entries_by_address(const reg_table_entry_t *matched[], uint16_t count)
{
    uint16_t i, j;
    const reg_table_entry_t *tmp;

    for (i = 0U; i < count; ++i)
    {
        for (j = (uint16_t)(i + 1U); j < count; ++j)
        {
            if (matched[i]->modbus_addr > matched[j]->modbus_addr)
            {
                tmp = matched[i];
                matched[i] = matched[j];
                matched[j] = tmp;
            }
        }
    }
}

int handle_modbus_read(uint8_t slave_addr, uint16_t start_addr, uint16_t num_regs)
{
    uint16_t i;
    uint16_t end_addr;
    uint8_t tx_buf[256];
    uint8_t *p;

    const reg_table_entry_t *entry;
    const reg_table_entry_t *matched[MAX_MATCHED_ENTRIES];
    uint16_t match_count = 0U;

    end_addr = (uint16_t)(start_addr + num_regs);
    p = &tx_buf[0];

    *p++ = slave_addr; 
    *p++ = 0x03; 
    *p++ = (uint8_t)(num_regs * 2U); 

    for (i = 0U; i < g_reg_table_slave_size; ++i)
    {
    	uint16_t addr;
    	uint16_t elemsize;
    	uint16_t total_regs;

        entry = &g_reg_table_slave[i];
        addr = entry->modbus_addr;
        elemsize = (uint16_t)(entry->size / entry->length);
        total_regs = (uint16_t)(((uint32_t)elemsize * entry->length) / 2U);

        if ((entry->access != ACCESS_WRITE) &&
            (addr >= start_addr) &&
            ((uint16_t)(addr + total_regs) <= end_addr))
        {
            if (match_count < MAX_MATCHED_ENTRIES)
            {
                matched[match_count++] = entry;
            }
        }
    }

    sort_entries_by_address(matched, match_count);

    /* Verify full range coverage: no gaps allowed */
    {
        uint16_t expected = start_addr;
        for (i = 0U; i < match_count; ++i)
        {
            uint16_t e_size = (uint16_t)(matched[i]->size / matched[i]->length);
            uint16_t e_regs = (uint16_t)(((uint32_t)e_size * matched[i]->length) / 2U);
            if (matched[i]->modbus_addr != expected)
            {
                return -1;
            }
            expected = (uint16_t)(matched[i]->modbus_addr + e_regs);
        }
        if (expected != end_addr)
        {
            return -1;
        }
    }

    for (i = 0U; i < match_count; ++i)
    {
    	uint16_t j = 0;
    	const uint8_t *src;
        entry = matched[i];
        src = (const uint8_t *)entry->ram_ptr;

        switch (entry->type)
        {
            case REG_TYPE_UINT16:
            case REG_TYPE_UINT16_ARRAY:
                for (j = 0U; j < entry->length; ++j)
                {
                	uint16_t v;
                	memcpy(&v, &src[j * 2], sizeof(v));
                    *p++ = (uint8_t)(v >> 8);
                    *p++ = (uint8_t)(v & 0xFF);
                }
                break;

            case REG_TYPE_UINT32:
            case REG_TYPE_UINT32_ARRAY:
                for (j = 0U; j < entry->length; ++j)
                {
                    uint32_t v;
					memcpy(&v, &src[j * 4], sizeof(v));
                    *p++ = (uint8_t)(v >> 24);
                    *p++ = (uint8_t)((v >> 16) & 0xFF);
                    *p++ = (uint8_t)((v >> 8) & 0xFF);
                    *p++ = (uint8_t)(v & 0xFF);
                }
                break;

            case REG_TYPE_FLOAT:
            case REG_TYPE_FLOAT_ARRAY:
                for (j = 0U; j < entry->length; ++j)
                {
                    union { float f; uint32_t u; } u32f;
                    memcpy(&u32f.f, &src[j * 4], sizeof(float));
                    *p++ = (uint8_t)(u32f.u >> 24);
                    *p++ = (uint8_t)((u32f.u >> 16) & 0xFF);
                    *p++ = (uint8_t)((u32f.u >> 8) & 0xFF);
                    *p++ = (uint8_t)(u32f.u & 0xFF);
                }
                break;

            case REG_TYPE_STRING:
                for (j = 0U; j < entry->length; j = (uint16_t)(j + 2U))
                {
                    *p++ = src[j];
                    *p++ = src[j + 1U];
                }
                break;

            case REG_TYPE_RESERVED:
                for (j = 0U; j < entry->length; ++j)
                {
                    *p++ = 0x00U;
                    *p++ = 0x00U;
                }
                break;

            default:
                break;
        }
    }

    (void)modbus_append_crc(tx_buf, (uint16_t)(p - tx_buf));
    ModbusPort_RequestSend(tx_buf, (uint16_t)((uint16_t)(p - tx_buf) + 2U));

    return 0;
}

void modbus_parse_and_reply(const uint8_t *rx_buf, uint16_t len)
{
    uint8_t slave_addr = 0U;
    uint8_t function = 0U;
    int valid_frame = 0;

    uint16_t start_addr = 0U;
    uint16_t num_regs = 0U;
    const uint8_t *data = (const uint8_t *)0;

    int status = 0;

    if ((rx_buf != (const uint8_t *)0) && (len >= MODBUS_MIN_FRAME_LENGTH) &&
        (len <= MODBUS_MAX_FRAME_LENGTH))
    {
        if (modbus_user_accept_slave_address(rx_buf[0]) == 0U)
        {
            return;
        }

        if (modbus_validate_crc(rx_buf, len) != 0)
        {
            slave_addr = rx_buf[0];
            function   = rx_buf[1];
            valid_frame = 1;
        }
        else
        {
            modbus_send_exception_response(rx_buf[0], rx_buf[1], MODBUS_EXC_ILLEGAL_DATA_VALUE);
        }
    }

    if (valid_frame != 0)
    {
        switch (function)
        {
            case MODBUS_FUNC_READ_HOLDING_REGS:  /* 0x03: Read Holding Registers */
                if (len >= MODBUS_MIN_FRAME_LENGTH)
                {
                    start_addr = (uint16_t)(((uint16_t)rx_buf[2] << 8U) | rx_buf[3]);
                    num_regs   = (uint16_t)(((uint16_t)rx_buf[4] << 8U) | (uint16_t)rx_buf[5]);
                    status = handle_modbus_read(slave_addr, start_addr, num_regs);
                    if (status != 0)
                    {
                        modbus_send_exception_response(slave_addr, function, MODBUS_EXC_ILLEGAL_DATA_ADDRESS);
                    }
                }
                else
                {
                    modbus_send_exception_response(slave_addr, function, MODBUS_EXC_ILLEGAL_DATA_VALUE);
                }
                break;

            case MODBUS_FUNC_WRITE_SINGLE_REG:  /* 0x06: Preset Single Register */
            	if (len >= MODBUS_MIN_FRAME_LENGTH)
            	{
            		start_addr  = (uint16_t)(((uint16_t)rx_buf[2] << 8U) | rx_buf[3]);

            		data = &rx_buf[4];
            		status = handle_modbus_multi_write(start_addr, 1U, data);
                    if (status == 0)
                    {
                        modbus_send_write_single_ack(slave_addr, start_addr, data);
                        modbus_reg_update_notify_master_write(start_addr, 1U);
                    }
            		else
            		{
                        modbus_send_exception_response(slave_addr, function, (uint8_t)status);
            		}
            	}
                else
                {
                    modbus_send_exception_response(slave_addr, function, MODBUS_EXC_ILLEGAL_DATA_VALUE);
                }
                break;

            case MODBUS_FUNC_DIAGNOSTICS:  /* 0x08: Diagnostics (Sub Function 0) */
                if ((len >= MODBUS_MIN_FRAME_LENGTH) &&
                    (rx_buf[2] == 0x00U) && (rx_buf[3] == 0x00U))
                {
                    modbus_send_echo_response(slave_addr, rx_buf, len);
                }
                else
                {
                    modbus_send_exception_response(slave_addr, function, MODBUS_EXC_ILLEGAL_FUNCTION);
                }
                break;

            case MODBUS_FUNC_WRITE_MULTIPLE_REGS:  /* 0x10: Write Multiple Registers */
                if (len >= (MODBUS_WRITE_MULTI_HEADER_LENGTH + 2U)) /* 7 + CRC */
                {
                    start_addr = (uint16_t)(((uint16_t)rx_buf[2] << 8U) | (uint16_t)rx_buf[3]);
                    num_regs   = (uint16_t)(((uint16_t)rx_buf[4] << 8U) | (uint16_t)rx_buf[5]);

                    if ((num_regs > 0U) &&
                        (num_regs <= (MODBUS_MAX_DATA_LENGTH / MODBUS_REG_SIZE_BYTES)) &&
                        (rx_buf[6] == (uint8_t)(num_regs * MODBUS_REG_SIZE_BYTES)) &&
                        (len >= (uint16_t)(MODBUS_WRITE_MULTI_HEADER_LENGTH +
                                          (num_regs * MODBUS_REG_SIZE_BYTES) + 2U)))
                    {
                    	data = &rx_buf[7];

                    	status = handle_modbus_multi_write(start_addr, num_regs, data);
                        if (status == 0)
                        {
                            modbus_send_write_multi_ack(slave_addr, start_addr, num_regs);
                            modbus_reg_update_notify_master_write(start_addr, num_regs);
                        }
                    	else
                    	{
                            modbus_send_exception_response(slave_addr, function, (uint8_t)status);
                    	}
                    }
                    else
                    {
                        modbus_send_exception_response(slave_addr, function, MODBUS_EXC_ILLEGAL_DATA_VALUE);
                    }
                }
                else
                {
                    modbus_send_exception_response(slave_addr, function, MODBUS_EXC_ILLEGAL_DATA_VALUE);
                }
                break;

            default:
                modbus_send_exception_response(slave_addr, function, MODBUS_EXC_ILLEGAL_FUNCTION);
                break;
        }
    }
}

void modbus_send_echo_response(uint8_t slave_addr, const uint8_t *rx_buf, uint16_t len)
{
    uint8_t frame[256];
    uint16_t i;
    uint16_t frame_len = 0U;
    int is_valid = 1;

    if ((rx_buf == (const uint8_t *)0) || (len < MODBUS_MIN_FRAME_LENGTH))
    {
        is_valid = 0;
    }
    else if (len > (uint16_t)sizeof(frame))
    {
        is_valid = 0;
    }

    if (is_valid != 0)
    {
        frame[0] = slave_addr;

        for (i = 1U; i < (uint16_t)(len - 2U); ++i)
        {
            frame[i] = rx_buf[i];
        }

        frame_len = modbus_append_crc(frame, (uint16_t)(len - 2U));

        ModbusPort_RequestSend(frame, frame_len);
    }
}

int check_range_float(float val, float min, float max)
{
    return ((val >= min) && (val <= max)) ? 1 : 0;
}

int check_range_uint16(uint16_t val, uint16_t min, uint16_t max)
{
    return ((val >= min) && (val <= max)) ? 1 : 0;
}

int check_range_uint32(uint32_t val, uint32_t min, uint32_t max)
{
    return ((val >= min) && (val <= max)) ? 1 : 0;
}

@ATOMIC@void modbus_send_write_multi_ack(uint8_t slave_addr, uint16_t start_addr, uint16_t num_regs)
{
    uint8_t tx_buf[8U];  /* addr + func + addr(2) + count(2) + CRC(2) */

    tx_buf[0] = slave_addr;
    tx_buf[1] = MODBUS_FUNC_WRITE_MULTIPLE_REGS;
    tx_buf[2] = (uint8_t)(start_addr >> 8U);
    tx_buf[3] = (uint8_t)(start_addr & 0xFFU);
    tx_buf[4] = (uint8_t)(num_regs >> 8U);
    tx_buf[5] = (uint8_t)(num_regs & 0xFFU);

    (void)modbus_append_crc(tx_buf, 6U);

    ModbusPort_RequestSend(tx_buf, 8U);
}

void modbus_send_write_single_ack(uint8_t slave_addr, uint16_t addr, const uint8_t *value)
{
    uint8_t tx_buf[8U];  /* addr + func + reg_addr(2) + value(2) + CRC(2) */

    tx_buf[0] = slave_addr;
    tx_buf[1] = MODBUS_FUNC_WRITE_SINGLE_REG;
    tx_buf[2] = (uint8_t)(addr >> 8U);
    tx_buf[3] = (uint8_t)(addr & 0xFFU);
    tx_buf[4] = value[0];
    tx_buf[5] = value[1];

    (void)modbus_append_crc(tx_buf, 6U);

    ModbusPort_RequestSend(tx_buf, 8U);
}

int modbus_validate_crc(const uint8_t* frame, uint16_t length)
{
    uint16_t i;
    uint8_t j;
    uint16_t crc = 0xFFFFU;
    uint16_t recv_crc = 0U;
    int result = 0;
    uint16_t byte;

    if (length >= 3U)
    {
        for (i = 0U; i < (uint16_t)(length - 2U); ++i)
        {
            byte = (uint16_t)frame[i];
            crc ^= byte;

            for (j = 0U; j < 8U; ++j)
            {
                if ((crc & 0x0001U) != 0U)
                {
                    crc = (uint16_t)((crc >> 1U) ^ 0xA001U);
                }
                else
                {
                    crc = (uint16_t)(crc >> 1U);
                }
            }
        }

        recv_crc = (uint16_t)(((uint16_t)frame[length - 1U] << 8U) | (uint16_t)frame[length - 2U]);

        if (crc == recv_crc)
        {
            result = 1;
        }
    }

    return result;
}

void modbus_send_exception_response(uint8_t slave_addr, uint8_t function_code, uint8_t exception_code)
{
    uint8_t response[5];
    uint16_t len;
    response[0] = slave_addr;
    response[1] = function_code | 0x80U;
    response[2] = exception_code;

    len = modbus_append_crc(response, 3U);

    ModbusPort_RequestSend(response, len);
}

uint16_t modbus_append_crc(uint8_t* frame, uint16_t len_without_crc)
{
    uint16_t crc = 0xFFFFU;
    uint16_t i;
    uint8_t j;
    uint16_t byte;

    for (i = 0U; i < len_without_crc; ++i)
    {
        byte = (uint16_t)frame[i];
        crc ^= byte;

        for (j = 0U; j < 8U; ++j)
        {
            if ((crc & 0x0001U) != 0U)
            {
                crc = (uint16_t)((crc >> 1U) ^ 0xA001U);
            }
            else
            {
                crc = (uint16_t)(crc >> 1U);
            }
        }
    }

    frame[len_without_crc]     = (uint8_t)(crc & 0xFFU);
    frame[len_without_crc + 1] = (uint8_t)((crc >> 8U) & 0xFFU);

    return (uint16_t)(len_without_crc + 2U);
}
`;

const PARSER_ATOMIC = String.raw`@SNAPSHOT_TYPE@
@GROUP_COPY_TYPE@
typedef union
{
    uint8_t bytes[MODBUS_MAX_DATA_LENGTH];
    uint32_t align_uint32;
    float align_float;
} modbus_write_scratch_t;

static modbus_write_scratch_t s_write_scratch;

static const reg_table_entry_t *find_entry_at_address(
    uint16_t address, uint16_t *table_index)
{
    uint16_t i;

    for (i = 0U; i < g_reg_table_slave_size; ++i)
    {
        if (g_reg_table_slave[i].modbus_addr == address)
        {
            *table_index = i;
            return &g_reg_table_slave[i];
        }
    }
    return (const reg_table_entry_t *)0;
}

static uint16_t entry_register_count(const reg_table_entry_t *entry)
{
    return (uint16_t)(entry->size / MODBUS_REG_SIZE_BYTES);
}

static void scratch_reset(uint16_t *front, uint16_t *back)
{
    *front = 0U;
    *back = MODBUS_MAX_DATA_LENGTH;
}

static void *scratch_allocate(const reg_table_entry_t *entry,
                              uint16_t *front, uint16_t *back)
{
    uint16_t new_back;
    void *result;

    if ((entry->type == REG_TYPE_UINT32) ||
        (entry->type == REG_TYPE_UINT32_ARRAY) ||
        (entry->type == REG_TYPE_FLOAT) ||
        (entry->type == REG_TYPE_FLOAT_ARRAY))
    {
        if (entry->size > *back)
        {
            return (void *)0;
        }
        new_back = (uint16_t)(*back - entry->size);
        if (new_back < *front)
        {
            return (void *)0;
        }
        *back = new_back;
        result = &s_write_scratch.bytes[new_back];
    }
    else
    {
        if ((uint16_t)(*back - *front) < entry->size)
        {
            return (void *)0;
        }
        result = &s_write_scratch.bytes[*front];
        *front = (uint16_t)(*front + entry->size);
    }
    return result;
}

static int decode_entry_after_value(const reg_table_entry_t *entry,
                                    const uint8_t *data,
                                    void *after_value)
{
    uint16_t i;
    uint16_t value16;
    uint32_t value32;
    uint16_t *dst16;
    uint32_t *dst32;
    float *dst_float;
    const uint16_t *min16;
    const uint16_t *max16;
    const uint32_t *min32;
    const uint32_t *max32;
    const float *min_float;
    const float *max_float;
    union { uint32_t u32; float f; } conv;

    switch (entry->type)
    {
        case REG_TYPE_UINT16:
        case REG_TYPE_UINT16_ARRAY:
            dst16 = (uint16_t *)after_value;
            min16 = (const uint16_t *)entry->min_value;
            max16 = (const uint16_t *)entry->max_value;
            for (i = 0U; i < entry->length; ++i)
            {
                value16 = (uint16_t)(((uint16_t)data[i * 2U] << 8U) |
                                     (uint16_t)data[i * 2U + 1U]);
                if ((value16 < min16[i]) || (value16 > max16[i]))
                {
                    return -1;
                }
                dst16[i] = value16;
            }
            return 0;

        case REG_TYPE_UINT32:
        case REG_TYPE_UINT32_ARRAY:
            dst32 = (uint32_t *)after_value;
            min32 = (const uint32_t *)entry->min_value;
            max32 = (const uint32_t *)entry->max_value;
            for (i = 0U; i < entry->length; ++i)
            {
                value32 = ((uint32_t)data[i * 4U] << 24U) |
                          ((uint32_t)data[i * 4U + 1U] << 16U) |
                          ((uint32_t)data[i * 4U + 2U] << 8U) |
                          (uint32_t)data[i * 4U + 3U];
                if ((value32 < min32[i]) || (value32 > max32[i]))
                {
                    return -1;
                }
                dst32[i] = value32;
            }
            return 0;

        case REG_TYPE_FLOAT:
        case REG_TYPE_FLOAT_ARRAY:
            dst_float = (float *)after_value;
            min_float = (const float *)entry->min_value;
            max_float = (const float *)entry->max_value;
            for (i = 0U; i < entry->length; ++i)
            {
                conv.u32 = ((uint32_t)data[i * 4U] << 24U) |
                           ((uint32_t)data[i * 4U + 1U] << 16U) |
                           ((uint32_t)data[i * 4U + 2U] << 8U) |
                           (uint32_t)data[i * 4U + 3U];
                if (!((conv.f >= min_float[i]) &&
                      (conv.f <= max_float[i])))
                {
                    return -1;
                }
                dst_float[i] = conv.f;
            }
            return 0;

        case REG_TYPE_STRING:
            if (modbus_string_field_is_valid(
                    (const char *)data, entry->size) == 0)
            {
                return -1;
            }
            (void)memcpy(after_value, data, entry->size);
            return 0;

        default:
            return -1;
    }
}

static modbus_write_result_t normalize_user_write_result(
    modbus_write_result_t result)
{
    switch (result)
    {
        case MODBUS_WRITE_OK:
        case MODBUS_WRITE_ILLEGAL_ADDRESS:
        case MODBUS_WRITE_ILLEGAL_VALUE:
        case MODBUS_WRITE_DEVICE_FAILURE:
        case MODBUS_WRITE_DEVICE_BUSY:
            return result;
        default:
            return MODBUS_WRITE_DEVICE_FAILURE;
    }
}

static modbus_write_result_t run_user_write_check(
    uint16_t table_index,
    const reg_table_entry_t *entry,
    const void *after_value)
{
    switch (table_index)
    {
@CHECKS@
        default:
@DEFAULT_CHECK@
            return MODBUS_WRITE_OK;
    }
}

static void snapshot_initialize(modbus_reg_snapshot_t *snapshot)
{
@INITIALIZE@
}

static void snapshot_set_after_pointer(modbus_reg_snapshot_t *snapshot,
                                       uint16_t table_index,
                                       const void *after_value)
{
    switch (table_index)
    {
@SET_POINTER@
        default:
            break;
    }
}

static int handle_modbus_multi_write(uint16_t start_addr,
                                     uint16_t num_regs,
                                     const uint8_t *data)
{
    uint32_t end_addr32;
    uint16_t end_addr;
    uint16_t expected;
    uint16_t table_index;
    uint16_t entry_regs;
    uint16_t front;
    uint16_t back;
    const uint8_t *entry_data;
    const reg_table_entry_t *entry;
    void *after_value;
    modbus_reg_snapshot_t snapshot;
@GROUP_COPY_VAR@
    modbus_write_result_t user_result;
    uint8_t nvm_changed = 0U;
@GROUP_FLAGS@

    if ((data == (const uint8_t *)0) || (num_regs == 0U) ||
        (num_regs > (MODBUS_MAX_DATA_LENGTH / MODBUS_REG_SIZE_BYTES)))
    {
        return MODBUS_EXC_ILLEGAL_DATA_VALUE;
    }
    end_addr32 = (uint32_t)start_addr + (uint32_t)num_regs;
    if (end_addr32 > 0x10000UL)
    {
        return MODBUS_EXC_ILLEGAL_DATA_ADDRESS;
    }
    end_addr = (uint16_t)end_addr32;

    expected = start_addr;
    while (expected != end_addr)
    {
        entry = find_entry_at_address(expected, &table_index);
        if ((entry == (const reg_table_entry_t *)0) ||
            (entry->type == REG_TYPE_RESERVED) ||
            (entry->access == ACCESS_READ))
        {
            return MODBUS_EXC_ILLEGAL_DATA_ADDRESS;
        }
        entry_regs = entry_register_count(entry);
        if ((entry_regs == 0U) ||
            ((uint32_t)expected + entry_regs > end_addr32))
        {
            return MODBUS_EXC_ILLEGAL_DATA_ADDRESS;
        }
        if (modbus_write_guard_entry_is_busy(table_index) != MB_FALSE)
        {
            return MODBUS_EXCEPTION_SLAVE_DEVICE_BUSY;
        }
        expected = (uint16_t)(expected + entry_regs);
    }

    snapshot_initialize(&snapshot);
    scratch_reset(&front, &back);
    expected = start_addr;
    while (expected != end_addr)
    {
        entry = find_entry_at_address(expected, &table_index);
        after_value = scratch_allocate(entry, &front, &back);
        if (after_value == (void *)0)
        {
            return MODBUS_EXC_SLAVE_DEVICE_FAILURE;
        }
        entry_data = &data[(uint16_t)(expected - start_addr) * 2U];
        if (decode_entry_after_value(entry, entry_data, after_value) != 0)
        {
            return MODBUS_EXC_ILLEGAL_DATA_VALUE;
        }
        user_result = normalize_user_write_result(
            run_user_write_check(table_index, entry, after_value));
        if (user_result != MODBUS_WRITE_OK)
        {
            return (int)user_result;
        }
        snapshot_set_after_pointer(&snapshot, table_index, after_value);
@GROUP_MEMBERS@
        expected = (uint16_t)(expected + entry_register_count(entry));
    }

@GROUP_VALIDATE@

    scratch_reset(&front, &back);
    expected = start_addr;
    while (expected != end_addr)
    {
        entry = find_entry_at_address(expected, &table_index);
        after_value = scratch_allocate(entry, &front, &back);
        if (memcmp(entry->ram_ptr, after_value, entry->size) != 0)
        {
            (void)memcpy(entry->ram_ptr, after_value, entry->size);
            if (entry->nvm_offset != NVM_OFFSET_UNUSED)
            {
                nvm_changed = 1U;
            }
        }
        expected = (uint16_t)(expected + entry_register_count(entry));
    }
    if (nvm_changed != 0U)
    {
        modbus_reg_nvm_mark_dirty();
    }
    return 0;
}
`;

const ACCESS_SCALAR_H = String.raw`@BASE@ get_@NAME@(void);
int set_@NAME@(@BASE@ value);
@MASK_DECL@
@BASE@ get_@NAME@_min(void);
@BASE@ get_@NAME@_max(void);
@BASE@ get_@NAME@_default(void);
`;

const ACCESS_MASK_H = String.raw`int set_@NAME@_masked(@BASE@ mask, @BASE@ value);`;

const ACCESS_SCALAR_C = String.raw`@BASE@ get_@NAME@(void)
{
    return @READ@(g_reg_table_slave[MODBUS_IDX_@NAME@].ram_ptr);
}
@SETTER@@BASE@ get_@NAME@_min(void)
{
    return @READ@(g_reg_table_slave[MODBUS_IDX_@NAME@].min_value);
}
@BASE@ get_@NAME@_max(void)
{
    return @READ@(g_reg_table_slave[MODBUS_IDX_@NAME@].max_value);
}
@BASE@ get_@NAME@_default(void)
{
    return @READ@(g_reg_table_slave[MODBUS_IDX_@NAME@].default_value);
}

`;

const ACCESS_SCALAR_SET = String.raw`int set_@NAME@(@BASE@ value)
{
    return @SET@(MODBUS_IDX_@NAME@, value);
}
`;

const ACCESS_SCALAR_SET_NOTIFY = String.raw`int set_@NAME@(@BASE@ value)
{
    int result;

    result = @SET@(MODBUS_IDX_@NAME@, value);
    if (result != 0)
    {
        modbus_reg_update_notify_internal_set(MODBUS_IDX_@NAME@);
    }
    return result;
}
`;

const ACCESS_MASK_C = String.raw`int set_@NAME@_masked(@BASE@ mask, @BASE@ value)
{
    @BASE@ current = get_@NAME@();
    value &= mask;  /* mask outside bits are cleared */
    current &= (@BASE@)(~mask);
    current |= value;
    return set_@NAME@(current);
}
`;

const ACCESS_SCALAR_CORE = String.raw`static int @SET@(uint16_t table_index, @BASE@ value)
{
    const reg_table_entry_t *entry;
    @BASE@ min_value;
    @BASE@ max_value;
    @BASE@ current;

    entry = &g_reg_table_slave[table_index];
    min_value = *((const @BASE@ *)entry->min_value);
    max_value = *((const @BASE@ *)entry->max_value);
    current = *((const @BASE@ *)entry->ram_ptr);

    if ((value < min_value) || (value > max_value))
    {
        return 0;
    }

    if (value != current)
    {
        *((@BASE@ *)entry->ram_ptr) = value;
        write_nvm_if_used(entry->nvm_offset,
                          entry->ram_ptr,
                          (uint16_t)sizeof(value));
    }

    return 1;
}
`;

const ACCESS_ARRAY_H = String.raw`@BASE@ get_@NAME@(uint16_t index);
int set_@NAME@(uint16_t index, @BASE@ value);
@BASE@ get_@NAME@_min(void);
@BASE@ get_@NAME@_max(void);
@BASE@ get_@NAME@_default(uint16_t index);
`;

const ACCESS_ARRAY_C = String.raw`@BASE@ get_@NAME@(uint16_t index)
{
    if (index >= @COUNT@U) { return (@BASE@)0; }
    return ((@BASE@ *)(g_reg_table_slave[MODBUS_IDX_@NAME@].ram_ptr))[index];
}
int set_@NAME@(uint16_t index, @BASE@ value)
{
    const @BASE@ min = @READ@(g_reg_table_slave[MODBUS_IDX_@NAME@].min_value);
    const @BASE@ max = @READ@(g_reg_table_slave[MODBUS_IDX_@NAME@].max_value);
    @BASE@ * const ram = (@BASE@ *)(g_reg_table_slave[MODBUS_IDX_@NAME@].ram_ptr);
    @BASE@ current;
    uint16_t nvm_offset;
    if (index >= @COUNT@U) { return 0; }
    if ((value < min) || (value > max))
    {
        return 0;
    }

    current = ram[index];
    if (value != current)
    {
        ram[index] = value;
        if (g_reg_table_slave[MODBUS_IDX_@NAME@].nvm_offset != NVM_OFFSET_UNUSED)
        {
            nvm_offset = (uint16_t)(g_reg_table_slave[MODBUS_IDX_@NAME@].nvm_offset + (uint16_t)(index * sizeof(@BASE@)));
            write_nvm_if_used(nvm_offset, &ram[index], (uint16_t)sizeof(value));
        }
    }
@NOTIFY@    return 1;
}
@BASE@ get_@NAME@_min(void)
{
    return @READ@(g_reg_table_slave[MODBUS_IDX_@NAME@].min_value);
}
@BASE@ get_@NAME@_max(void)
{
    return @READ@(g_reg_table_slave[MODBUS_IDX_@NAME@].max_value);
}
@BASE@ get_@NAME@_default(uint16_t index)
{
    if (index >= @COUNT@U) { return (@BASE@)0; }
    return ((const @BASE@ *)(g_reg_table_slave[MODBUS_IDX_@NAME@].default_value))[index];
}
`;

const ACCESS_STRING_H = String.raw`#define MODBUS_@NAME@_MAX_LENGTH  (@COUNT@U)
#define MODBUS_@NAME@_BUFFER_SIZE (MODBUS_@NAME@_MAX_LENGTH + 1U)
int get_@NAME@_copy(char *dst, uint16_t dst_size);
int set_@NAME@(const char *value);
`;

const ACCESS_STRING_C = String.raw`int get_@NAME@_copy(char *dst, uint16_t dst_size)
{
    const char *src = (const char *)(g_reg_table_slave[MODBUS_IDX_@NAME@].ram_ptr);
    const uint16_t len = modbus_string_field_length(src, @COUNT@U);

    if ((dst == (char *)0) || (dst_size <= len))
    {
        return 0;
    }

    (void)memcpy(dst, src, len);
    dst[len] = '\0';
    return 1;
}

int set_@NAME@(const char *value)
{
    char temp[@COUNT@];
    char * const ram = (char *)(g_reg_table_slave[MODBUS_IDX_@NAME@].ram_ptr);
    const uint16_t len = string_length_limited(value, @COUNT_PLUS_ONE@U);

    if (is_valid_string_value(value, @COUNT@U) == 0)
    {
        return 0;
    }

    (void)memset(temp, 0, sizeof(temp));
    (void)memcpy(temp, value, len);

    if (memcmp(ram, temp, sizeof(temp)) != 0)
    {
        (void)memcpy(ram, temp, sizeof(temp));
        write_nvm_if_used(g_reg_table_slave[MODBUS_IDX_@NAME@].nvm_offset, ram, g_reg_table_slave[MODBUS_IDX_@NAME@].size);
    }
@NOTIFY@    return 1;
}
`;
