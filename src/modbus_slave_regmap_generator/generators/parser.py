from __future__ import annotations

from typing import List

from ..utils import get_base_type
from ..workbook_loader import WorkbookData
from . import GeneratedFile

MODBUS_PARSER_HEADER = """\
/*
 * modbus_parser.h
 *
 *  Created on: 2025/05/22
 *      Author: 1225190
 */

#ifndef MODBUSLAYER_MODBUS_PARSER_H_
#define MODBUSLAYER_MODBUS_PARSER_H_

#include <stdint.h>

#define MODBUS_EXCEPTION_SLAVE_DEVICE_BUSY  (0x06U)

extern void NVM_Request_Write_Bytes(uint16_t offset,
                                    const uint8_t *data,
                                    uint16_t length);

extern void ModbusPort_RequestSend(const uint8_t *frame, uint16_t length);

void modbus_send_exception_response(uint8_t slave_addr, uint8_t function_code, uint8_t exception_code);
void modbus_parse_and_reply(const uint8_t *rx_buf, uint16_t len);

#endif /* MODBUSLAYER_MODBUS_PARSER_H_ */
"""

MODBUS_PARSER_SOURCE = """\
#include "modbus_parser.h"
#include "modbus_reg_map_slave.h"
#include "modbus_reg_idx_slave.h"
#include "modbus_reg_update_notify_slave.h"
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
#define MODBUS_SINGLE_REG_DATA_LENGTH      (4U)  /* 2 bytes address + 2 bytes data */
#define MODBUS_WRITE_MULTI_HEADER_LENGTH   (7U)  /* 7 = addr(1) + func(1) + start(2) + count(2) + byte count(1) */

#define MODBUS_REG_SIZE_BYTES    (2U)
#define MODBUS_MAX_DATA_LENGTH   (252U)

#define MAX_MATCHED_ENTRIES 256U

#define FLOAT_EPSILON (1.0e-6f)

static int check_range_float(float val, float min, float max);
static int check_range_uint16(uint16_t val, uint16_t min, uint16_t max);
static int check_range_uint32(uint32_t val, uint32_t min, uint32_t max);

static int handle_write_uint16_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len);
static int handle_write_uint32_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len);
static int handle_write_float_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len);
static int handle_write_string_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len);

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

    if ((rx_buf != (const uint8_t *)0) && (len >= MODBUS_MIN_FRAME_LENGTH))
    {
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

    if ((rx_buf == (const uint8_t *)0) || (len == 0U))
    {
        is_valid = 0;
    }
    else if (len > (sizeof(frame) - 2U))
    {
        is_valid = 0;
    }

    if (is_valid != 0)
    {
        frame[0] = slave_addr;

        for (i = 1U; i < len; ++i)
        {
            frame[i] = rx_buf[i];
        }

        frame_len = modbus_append_crc(frame, len);

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

int handle_modbus_multi_write(uint16_t start_addr, uint16_t num_regs, const uint8_t *data)
{
    uint16_t end_addr = (uint16_t)(start_addr + num_regs);
    uint16_t i;
    int result = 0;

    for (i = 0U; i < g_reg_table_slave_size; ++i)
    {
    	int status = -1;
    	uint16_t addr;
    	uint16_t elemsize;
    	uint16_t total_regs;
    	const uint8_t *entry_data;
        const reg_table_entry_t *entry = &g_reg_table_slave[i];

        if (entry->access == ACCESS_READ)
        {
            continue;
        }

        addr = entry->modbus_addr;
        elemsize = entry->size / entry->length;
        total_regs = (uint16_t)(((uint32_t)elemsize * (uint32_t)entry->length) / 2U);

        if ((addr < start_addr) || ((uint16_t)(addr + total_regs) > end_addr))
        {
            continue;
        }

        entry_data = &data[(uint16_t)(addr - start_addr) * 2U];

        switch (entry->type)
        {
            case REG_TYPE_UINT16:
            case REG_TYPE_UINT16_ARRAY:
                status = handle_write_uint16_entry(entry, entry_data, entry->length);
                break;

            case REG_TYPE_UINT32:
            case REG_TYPE_UINT32_ARRAY:
                status = handle_write_uint32_entry(entry, entry_data, entry->length);
                break;

            case REG_TYPE_FLOAT:
            case REG_TYPE_FLOAT_ARRAY:
                status = handle_write_float_entry(entry, entry_data, entry->length);
                break;

            case REG_TYPE_STRING:
                status = handle_write_string_entry(entry, entry_data, entry->length);
                break;

            default:
                status = -1;
                break;
        }

        if (status != 0)
        {
            result = -1;
        }
    }

    return result;
}

int handle_write_uint16_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len)
{
    uint16_t i;
    int is_valid_ptr = 1;
    int is_valid_len = 1;
    int is_valid_buf = 1;
    int is_valid_data = 1;
    int need_write = 0;
    uint16_t current;
    uint16_t incoming;
    uint8_t temp_buf[256];

    const uint16_t *ram = (const uint16_t *)entry->ram_ptr;
    const uint16_t min = *(const uint16_t *)(entry->min_value);
    const uint16_t max = *(const uint16_t *)(entry->max_value);

    int is_all_valid = 0;

    if ((entry == (const reg_table_entry_t *)0) || (data == (const uint8_t *)0))
    {
        is_valid_ptr = 0;
    }
    if (len != entry->length)
    {
        is_valid_len = 0;
    }
    if ((len * 2U) > sizeof(temp_buf))
    {
        is_valid_buf = 0;
    }

    if ((is_valid_ptr != 0) && (is_valid_len != 0) && (is_valid_buf != 0))
    {
        for (i = 0U; i < len; ++i)
        {
            incoming = (uint16_t)(((uint32_t)data[i * 2U] << 8U) | (uint32_t)data[i * 2U + 1U]);
            current = ram[i];

            if (check_range_uint16(incoming, min, max) == 0)
            {
                is_valid_data = 0;
            }
            if (incoming != current)
            {
                need_write = 1;
            }
            memcpy(&temp_buf[i * 2], &incoming, sizeof(uint16_t));
        }
    }

    is_all_valid = (is_valid_ptr != 0) && (is_valid_len != 0) && (is_valid_buf != 0) && (is_valid_data != 0);

    if (is_all_valid && (need_write != 0))
    {
        (void)memcpy((void *)entry->ram_ptr, temp_buf, (size_t)(len * sizeof(uint16_t)));

        if (entry->nvm_offset != NVM_OFFSET_UNUSED)
        {
            NVM_Request_Write_Bytes(entry->nvm_offset, temp_buf,
                                    (uint16_t)(len * sizeof(uint16_t)));
        }
    }

    return is_all_valid ? 0 : -1;
}


int handle_write_uint32_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len)
{
    uint16_t i;
    int is_valid_ptr = 1;
    int is_valid_len = 1;
    int is_valid_buf = 1;
    int is_valid_data = 1;
    int need_write = 0;
    uint32_t current;
    uint32_t incoming;
    uint8_t temp_buf[256];

    const uint32_t *ram = (const uint32_t *)entry->ram_ptr;
    const uint32_t min = *(const uint32_t *)(entry->min_value);
    const uint32_t max = *(const uint32_t *)(entry->max_value);

    int is_all_valid = 0;

    if ((entry == (const reg_table_entry_t *)0) || (data == (const uint8_t *)0))
    {
        is_valid_ptr = 0;
    }
    if (len != entry->length)
    {
        is_valid_len = 0;
    }
    if ((len * 4U) > sizeof(temp_buf))
    {
        is_valid_buf = 0;
    }

    if ((is_valid_ptr != 0) && (is_valid_len != 0) && (is_valid_buf != 0))
    {
        for (i = 0U; i < len; ++i)
        {
            incoming = ((uint32_t)data[i * 4U] << 24U) |
                       ((uint32_t)data[i * 4U + 1U] << 16U) |
                       ((uint32_t)data[i * 4U + 2U] << 8U) |
                       ((uint32_t)data[i * 4U + 3U]);
            current = ram[i];

            if (check_range_uint32(incoming, min, max) == 0)
            {
                is_valid_data = 0;
            }

            if (incoming != current)
            {
                need_write = 1;
            }
            memcpy(&temp_buf[i * 4], &incoming, sizeof(uint32_t));
        }
    }

    is_all_valid = (is_valid_ptr != 0) && (is_valid_len != 0) &&
                   (is_valid_buf != 0) && (is_valid_data != 0);

    if (is_all_valid && (need_write != 0))
    {
        (void)memcpy((void *)entry->ram_ptr, temp_buf, (size_t)(len * sizeof(uint32_t)));

        if (entry->nvm_offset != NVM_OFFSET_UNUSED)
        {
            NVM_Request_Write_Bytes(entry->nvm_offset, temp_buf,
                                    (uint16_t)(len * sizeof(uint32_t)));
        }
    }

    return is_all_valid ? 0 : -1;
}

int handle_write_float_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len)
{
    uint16_t i;
    int is_valid_ptr = 1;
    int is_valid_len = 1;
    int is_valid_buf = 1;
    int is_valid_data = 1;
    int need_write = 0;
    float current;
    float incoming;
    uint8_t temp_buf[256];

    const float *ram = (const float *)entry->ram_ptr;
    const float min = *(const float *)(entry->min_value);
    const float max = *(const float *)(entry->max_value);

    int is_all_valid = 0;
    union {
        uint32_t u32;
        float f;
    } conv;

    if ((entry == (const reg_table_entry_t *)0) || (data == (const uint8_t *)0))
    {
        is_valid_ptr = 0;
    }
    if (len != entry->length)
    {
        is_valid_len = 0;
    }
    if ((len * 4U) > sizeof(temp_buf))
    {
        is_valid_buf = 0;
    }

    if ((is_valid_ptr != 0) && (is_valid_len != 0) && (is_valid_buf != 0))
    {
        for (i = 0U; i < len; ++i)
        {
            conv.u32 = ((uint32_t)data[i * 4U] << 24U) |
                       ((uint32_t)data[i * 4U + 1U] << 16U) |
                       ((uint32_t)data[i * 4U + 2U] << 8U) |
                       ((uint32_t)data[i * 4U + 3U]);
            incoming = conv.f;
            current = ram[i];

            if (check_range_float(incoming, min, max) == 0)
            {
                is_valid_data = 0;
            }

            if (!is_float_equal(incoming, current))
            {
                need_write = 1;
            }
            memcpy(&temp_buf[i * sizeof(float)], &incoming, sizeof(float));
        }
    }

    is_all_valid = (is_valid_ptr != 0) && (is_valid_len != 0) &&
                   (is_valid_buf != 0) && (is_valid_data != 0);

    if (is_all_valid && (need_write != 0))
    {
        (void)memcpy((void *)entry->ram_ptr, temp_buf, (size_t)(len * sizeof(float)));

        if (entry->nvm_offset != NVM_OFFSET_UNUSED)
        {
            NVM_Request_Write_Bytes(entry->nvm_offset, temp_buf,
                                    (uint16_t)(len * sizeof(float)));
        }
    }

    return is_all_valid ? 0 : -1;
}

int handle_write_string_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len)
{
    int is_valid_ptr = 1;
    int is_valid_len = 1;
    int is_valid_buf = 1;
    int is_valid_data = 1;
    int need_write = 0;
    uint8_t temp_buf[256];

    int is_all_valid = 0;

    if ((entry == (const reg_table_entry_t *)0) || (data == (const uint8_t *)0))
    {
        is_valid_ptr = 0;
    }
    if ((entry != (const reg_table_entry_t *)0) && (len != entry->length))
    {
        is_valid_len = 0;
    }
    if (len > sizeof(temp_buf))
    {
        is_valid_buf = 0;
    }

    if ((is_valid_ptr != 0) && (is_valid_len != 0) && (is_valid_buf != 0))
    {
        if (modbus_string_field_is_valid((const char *)data, len) == 0)
        {
            is_valid_data = 0;
        }
        (void)memcpy(temp_buf, data, len);
    }

    is_all_valid = (is_valid_ptr != 0) && (is_valid_len != 0) &&
                   (is_valid_buf != 0) && (is_valid_data != 0);

    if (is_all_valid != 0)
    {
        if (memcmp(entry->ram_ptr, temp_buf, len) != 0)
        {
            need_write = 1;
        }
    }

    if (is_all_valid && (need_write != 0))
    {
        (void)memcpy((void *)entry->ram_ptr, temp_buf, len);

        if (entry->nvm_offset != NVM_OFFSET_UNUSED)
        {
            NVM_Request_Write_Bytes(entry->nvm_offset, temp_buf, len);
        }
    }

    return is_all_valid ? 0 : -1;
}

void modbus_send_write_multi_ack(uint8_t slave_addr, uint16_t start_addr, uint16_t num_regs)
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
"""


def _build_write_check_cases(workbook: WorkbookData) -> List[str]:
    lines: List[str] = []
    for entry in workbook.entries:
        if not entry["write_check"]:
            continue
        name = entry["name"]
        base_type = get_base_type(entry["type"])
        lines.append(f"        case MODBUS_IDX_{name}:")
        if entry["type"] == "REG_TYPE_STRING":
            lines.extend(
                [
                    "        {",
                    "            modbus_string_view_t current_value;",
                    "            modbus_string_view_t new_value;",
                    "",
                    "            current_value.data = (const char *)entry->ram_ptr;",
                    "            current_value.length = modbus_string_field_length(",
                    "                current_value.data, entry->size);",
                    "            new_value.data = (const char *)after_value;",
                    "            new_value.length = modbus_string_field_length(",
                    "                new_value.data, entry->size);",
                    f"            return modbus_user_write_check_{name}(",
                    "                &current_value, &new_value);",
                    "        }",
                ]
            )
        elif entry["is_array"]:
            lines.extend(
                [
                    f"            return modbus_user_write_check_{name}(",
                    f"                (const {base_type} *)entry->ram_ptr,",
                    f"                (const {base_type} *)after_value,",
                    "                entry->length);",
                ]
            )
        else:
            lines.extend(
                [
                    f"            return modbus_user_write_check_{name}(",
                    f"                *((const {base_type} *)entry->ram_ptr),",
                    f"                *((const {base_type} *)after_value));",
                ]
            )
    return lines


def _build_atomic_write_source(workbook: WorkbookData) -> str:
    snapshot_entries = [
        entry
        for entry in workbook.entries
        if entry["type"] != "REG_TYPE_RESERVED" and entry["group_validate"] is not None
    ]

    lines = [
        "typedef union",
        "{",
        "    uint8_t bytes[MODBUS_MAX_DATA_LENGTH];",
        "    uint32_t align_uint32;",
        "    float align_float;",
        "} modbus_write_scratch_t;",
        "",
        "static modbus_write_scratch_t s_write_scratch;",
        "",
        "static const reg_table_entry_t *find_entry_at_address(",
        "    uint16_t address, uint16_t *table_index)",
        "{",
        "    uint16_t i;",
        "",
        "    for (i = 0U; i < g_reg_table_slave_size; ++i)",
        "    {",
        "        if (g_reg_table_slave[i].modbus_addr == address)",
        "        {",
        "            *table_index = i;",
        "            return &g_reg_table_slave[i];",
        "        }",
        "    }",
        "    return (const reg_table_entry_t *)0;",
        "}",
        "",
        "static uint16_t entry_register_count(const reg_table_entry_t *entry)",
        "{",
        "    return (uint16_t)(entry->size / MODBUS_REG_SIZE_BYTES);",
        "}",
        "",
        "static void scratch_reset(uint16_t *front, uint16_t *back)",
        "{",
        "    *front = 0U;",
        "    *back = MODBUS_MAX_DATA_LENGTH;",
        "}",
        "",
        "static void *scratch_allocate(const reg_table_entry_t *entry,",
        "                              uint16_t *front, uint16_t *back)",
        "{",
        "    uint16_t new_back;",
        "    void *result;",
        "",
        "    if ((entry->type == REG_TYPE_UINT32) ||",
        "        (entry->type == REG_TYPE_UINT32_ARRAY) ||",
        "        (entry->type == REG_TYPE_FLOAT) ||",
        "        (entry->type == REG_TYPE_FLOAT_ARRAY))",
        "    {",
        "        if (entry->size > *back)",
        "        {",
        "            return (void *)0;",
        "        }",
        "        new_back = (uint16_t)(*back - entry->size);",
        "        if (new_back < *front)",
        "        {",
        "            return (void *)0;",
        "        }",
        "        *back = new_back;",
        "        result = &s_write_scratch.bytes[new_back];",
        "    }",
        "    else",
        "    {",
        "        if ((uint16_t)(*back - *front) < entry->size)",
        "        {",
        "            return (void *)0;",
        "        }",
        "        result = &s_write_scratch.bytes[*front];",
        "        *front = (uint16_t)(*front + entry->size);",
        "    }",
        "    return result;",
        "}",
        "",
        "static int decode_entry_after_value(const reg_table_entry_t *entry,",
        "                                    const uint8_t *data,",
        "                                    void *after_value)",
        "{",
        "    uint16_t i;",
        "    uint16_t value16;",
        "    uint32_t value32;",
        "    uint16_t *dst16;",
        "    uint32_t *dst32;",
        "    float *dst_float;",
        "    const uint16_t *min16;",
        "    const uint16_t *max16;",
        "    const uint32_t *min32;",
        "    const uint32_t *max32;",
        "    const float *min_float;",
        "    const float *max_float;",
        "    union { uint32_t u32; float f; } conv;",
        "",
        "    switch (entry->type)",
        "    {",
        "        case REG_TYPE_UINT16:",
        "        case REG_TYPE_UINT16_ARRAY:",
        "            dst16 = (uint16_t *)after_value;",
        "            min16 = (const uint16_t *)entry->min_value;",
        "            max16 = (const uint16_t *)entry->max_value;",
        "            for (i = 0U; i < entry->length; ++i)",
        "            {",
        "                value16 = (uint16_t)(((uint16_t)data[i * 2U] << 8U) |",
        "                                     (uint16_t)data[i * 2U + 1U]);",
        "                if ((value16 < min16[i]) || (value16 > max16[i]))",
        "                {",
        "                    return -1;",
        "                }",
        "                dst16[i] = value16;",
        "            }",
        "            return 0;",
        "",
        "        case REG_TYPE_UINT32:",
        "        case REG_TYPE_UINT32_ARRAY:",
        "            dst32 = (uint32_t *)after_value;",
        "            min32 = (const uint32_t *)entry->min_value;",
        "            max32 = (const uint32_t *)entry->max_value;",
        "            for (i = 0U; i < entry->length; ++i)",
        "            {",
        "                value32 = ((uint32_t)data[i * 4U] << 24U) |",
        "                          ((uint32_t)data[i * 4U + 1U] << 16U) |",
        "                          ((uint32_t)data[i * 4U + 2U] << 8U) |",
        "                          (uint32_t)data[i * 4U + 3U];",
        "                if ((value32 < min32[i]) || (value32 > max32[i]))",
        "                {",
        "                    return -1;",
        "                }",
        "                dst32[i] = value32;",
        "            }",
        "            return 0;",
        "",
        "        case REG_TYPE_FLOAT:",
        "        case REG_TYPE_FLOAT_ARRAY:",
        "            dst_float = (float *)after_value;",
        "            min_float = (const float *)entry->min_value;",
        "            max_float = (const float *)entry->max_value;",
        "            for (i = 0U; i < entry->length; ++i)",
        "            {",
        "                conv.u32 = ((uint32_t)data[i * 4U] << 24U) |",
        "                           ((uint32_t)data[i * 4U + 1U] << 16U) |",
        "                           ((uint32_t)data[i * 4U + 2U] << 8U) |",
        "                           (uint32_t)data[i * 4U + 3U];",
        "                if ((conv.f < min_float[i]) || (conv.f > max_float[i]))",
        "                {",
        "                    return -1;",
        "                }",
        "                dst_float[i] = conv.f;",
        "            }",
        "            return 0;",
        "",
        "        case REG_TYPE_STRING:",
        "            if (modbus_string_field_is_valid(",
        "                    (const char *)data, entry->size) == 0)",
        "            {",
        "                return -1;",
        "            }",
        "            (void)memcpy(after_value, data, entry->size);",
        "            return 0;",
        "",
        "        default:",
        "            return -1;",
        "    }",
        "}",
        "",
            "static modbus_write_result_t normalize_user_write_result(",
            "    modbus_write_result_t result)",
            "{",
            "    switch (result)",
            "    {",
            "        case MODBUS_WRITE_OK:",
            "        case MODBUS_WRITE_ILLEGAL_ADDRESS:",
            "        case MODBUS_WRITE_ILLEGAL_VALUE:",
            "        case MODBUS_WRITE_DEVICE_FAILURE:",
            "        case MODBUS_WRITE_DEVICE_BUSY:",
            "            return result;",
            "        default:",
            "            return MODBUS_WRITE_DEVICE_FAILURE;",
            "    }",
            "}",
            "",
            "static modbus_write_result_t run_user_write_check(",
            "    uint16_t table_index,",
            "    const reg_table_entry_t *entry,",
            "    const void *after_value)",
        "{",
        "    switch (table_index)",
        "    {",
    ]
    lines.extend(_build_write_check_cases(workbook))
    lines.extend(
        [
            "        default:",
            "            return MODBUS_WRITE_OK;",
            "    }",
            "}",
            "",
            "static void snapshot_initialize(modbus_reg_snapshot_t *snapshot)",
            "{",
        ]
    )
    if snapshot_entries:
        for entry in snapshot_entries:
            if entry["type"] == "REG_TYPE_STRING":
                lines.extend(
                    [
                        f"    snapshot->{entry['name']}.data = (const char *)",
                        f"        g_reg_table_slave[MODBUS_IDX_{entry['name']}].ram_ptr;",
                        f"    snapshot->{entry['name']}.length = modbus_string_field_length(",
                        f"        snapshot->{entry['name']}.data,",
                        f"        g_reg_table_slave[MODBUS_IDX_{entry['name']}].size);",
                    ]
                )
            else:
                base_type = get_base_type(entry["type"])
                lines.append(
                    f"    snapshot->{entry['name']} = (const {base_type} *)"
                    f"g_reg_table_slave[MODBUS_IDX_{entry['name']}].ram_ptr;"
                )
    else:
        lines.append("    snapshot->unused = (const uint8_t *)0;")
    lines.extend(
        [
            "}",
            "",
            "static void snapshot_set_after_pointer(modbus_reg_snapshot_t *snapshot,",
            "                                       uint16_t table_index,",
            "                                       const void *after_value)",
            "{",
            "    switch (table_index)",
            "    {",
        ]
    )
    for entry in snapshot_entries:
        if entry["type"] == "REG_TYPE_STRING":
            lines.extend(
                [
                    f"        case MODBUS_IDX_{entry['name']}:",
                    f"            snapshot->{entry['name']}.data = (const char *)after_value;",
                    f"            snapshot->{entry['name']}.length =",
                    "                modbus_string_field_length(",
                    f"                    snapshot->{entry['name']}.data,",
                    f"                    g_reg_table_slave[MODBUS_IDX_{entry['name']}].size);",
                    "            break;",
                ]
            )
        else:
            base_type = get_base_type(entry["type"])
            lines.extend(
                [
                    f"        case MODBUS_IDX_{entry['name']}:",
                    f"            snapshot->{entry['name']} = (const {base_type} *)after_value;",
                    "            break;",
                ]
            )
    lines.extend(
        [
            "        default:",
            "            break;",
            "    }",
            "}",
            "",
            "static int handle_modbus_multi_write(uint16_t start_addr,",
            "                                     uint16_t num_regs,",
            "                                     const uint8_t *data)",
            "{",
            "    uint32_t end_addr32;",
            "    uint16_t end_addr;",
            "    uint16_t expected;",
            "    uint16_t table_index;",
            "    uint16_t entry_regs;",
            "    uint16_t front;",
            "    uint16_t back;",
            "    const uint8_t *entry_data;",
            "    const reg_table_entry_t *entry;",
            "    void *after_value;",
            "    modbus_reg_snapshot_t snapshot;",
            "    modbus_write_result_t user_result;",
        ]
    )
    for group_name in workbook.group_validate_names:
        lines.append(f"    MB_BOOL group_{group_name}_affected = MB_FALSE;")
    lines.extend(
        [
            "",
            "    if ((data == (const uint8_t *)0) || (num_regs == 0U) ||",
            "        (num_regs > (MODBUS_MAX_DATA_LENGTH / MODBUS_REG_SIZE_BYTES)))",
            "    {",
            "        return MODBUS_EXC_ILLEGAL_DATA_VALUE;",
            "    }",
            "    end_addr32 = (uint32_t)start_addr + (uint32_t)num_regs;",
            "    if (end_addr32 > 0x10000UL)",
            "    {",
            "        return MODBUS_EXC_ILLEGAL_DATA_ADDRESS;",
            "    }",
            "    end_addr = (uint16_t)end_addr32;",
            "",
            "    expected = start_addr;",
            "    while (expected != end_addr)",
            "    {",
            "        entry = find_entry_at_address(expected, &table_index);",
            "        if ((entry == (const reg_table_entry_t *)0) ||",
            "            (entry->type == REG_TYPE_RESERVED) ||",
            "            (entry->access == ACCESS_READ))",
            "        {",
            "            return MODBUS_EXC_ILLEGAL_DATA_ADDRESS;",
            "        }",
            "        entry_regs = entry_register_count(entry);",
            "        if ((entry_regs == 0U) ||",
            "            ((uint32_t)expected + entry_regs > end_addr32))",
            "        {",
            "            return MODBUS_EXC_ILLEGAL_DATA_ADDRESS;",
            "        }",
            "        if (modbus_write_guard_entry_is_busy(table_index) != MB_FALSE)",
            "        {",
            "            return MODBUS_EXCEPTION_SLAVE_DEVICE_BUSY;",
            "        }",
            "        expected = (uint16_t)(expected + entry_regs);",
            "    }",
            "",
            "    snapshot_initialize(&snapshot);",
            "    scratch_reset(&front, &back);",
            "    expected = start_addr;",
            "    while (expected != end_addr)",
            "    {",
            "        entry = find_entry_at_address(expected, &table_index);",
            "        after_value = scratch_allocate(entry, &front, &back);",
            "        if (after_value == (void *)0)",
            "        {",
            "            return MODBUS_EXC_SLAVE_DEVICE_FAILURE;",
            "        }",
            "        entry_data = &data[(uint16_t)(expected - start_addr) * 2U];",
            "        if (decode_entry_after_value(entry, entry_data, after_value) != 0)",
            "        {",
            "            return MODBUS_EXC_ILLEGAL_DATA_VALUE;",
            "        }",
            "        user_result = normalize_user_write_result(",
            "            run_user_write_check(table_index, entry, after_value));",
            "        if (user_result != MODBUS_WRITE_OK)",
            "        {",
            "            return (int)user_result;",
            "        }",
            "        snapshot_set_after_pointer(&snapshot, table_index, after_value);",
        ]
    )
    for group_name in workbook.group_validate_names:
        group_entries = [
            entry
            for entry in snapshot_entries
            if entry["group_validate"] == group_name
        ]
        if group_entries:
            condition = " || ".join(
                f"table_index == MODBUS_IDX_{entry['name']}"
                for entry in group_entries
            )
            lines.extend(
                [
                    f"        if ({condition})",
                    "        {",
                    f"            group_{group_name}_affected = MB_TRUE;",
                    "        }",
                ]
            )
    lines.extend(
        [
            "        expected = (uint16_t)(expected + entry_register_count(entry));",
            "    }",
            "",
        ]
    )
    for group_name in workbook.group_validate_names:
        lines.extend(
            [
                f"    if (group_{group_name}_affected != MB_FALSE)",
                "    {",
                "        user_result = normalize_user_write_result(",
                f"            modbus_user_group_validate_{group_name}(&snapshot));",
                "        if (user_result != MODBUS_WRITE_OK)",
                "        {",
                "            return (int)user_result;",
                "        }",
                "    }",
            ]
        )
    lines.extend(
        [
            "",
            "    scratch_reset(&front, &back);",
            "    expected = start_addr;",
            "    while (expected != end_addr)",
            "    {",
            "        entry = find_entry_at_address(expected, &table_index);",
            "        after_value = scratch_allocate(entry, &front, &back);",
            "        if (memcmp(entry->ram_ptr, after_value, entry->size) != 0)",
            "        {",
            "            (void)memcpy(entry->ram_ptr, after_value, entry->size);",
            "            if (entry->nvm_offset != NVM_OFFSET_UNUSED)",
            "            {",
            "                NVM_Request_Write_Bytes(entry->nvm_offset,",
            "                                        (const uint8_t *)entry->ram_ptr,",
            "                                        entry->size);",
            "            }",
            "        }",
            "        expected = (uint16_t)(expected + entry_register_count(entry));",
            "    }",
            "    return 0;",
            "}",
            "",
        ]
    )
    return "\n".join(lines)


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    """Return generated Modbus parser files."""
    source = MODBUS_PARSER_SOURCE
    for declaration in [
        "static int handle_write_uint16_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len);\n",
        "static int handle_write_uint32_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len);\n",
        "static int handle_write_float_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len);\n",
        "static int handle_write_string_entry(const reg_table_entry_t *entry, const uint8_t *data, uint16_t len);\n",
    ]:
        source = source.replace(declaration, "")

    start_marker = (
        "int handle_modbus_multi_write(uint16_t start_addr, uint16_t num_regs, "
        "const uint8_t *data)\n{"
    )
    end_marker = "void modbus_send_write_multi_ack"
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    source = source[:start] + _build_atomic_write_source(workbook) + source[end:]

    return [
        GeneratedFile("modbus_parser.h", MODBUS_PARSER_HEADER),
        GeneratedFile("modbus_parser.c", source),
    ]
