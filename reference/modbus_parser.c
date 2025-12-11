// modbus_parser.c

#include "modbus_parser.h"
#include "modbus_reg_map.h"
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
    int is_success = 0;

    end_addr = (uint16_t)(start_addr + num_regs);
    p = &tx_buf[0];

    *p++ = slave_addr; // slave address
    *p++ = 0x03; // function code: read holding registers
    *p++ = (uint8_t)(num_regs * 2U); // byte count

    for (i = 0U; i < g_reg_table_size; ++i)
    {
    	uint16_t addr;
    	uint16_t elemsize;
    	uint16_t total_regs;

        entry = &g_reg_table[i];
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

            default:
                break;
        }
    }

    (void)modbus_append_crc(tx_buf, (uint16_t)(p - tx_buf));
    ModbusPort_RequestSend(tx_buf, (uint16_t)((uint16_t)(p - tx_buf) + 2U));

    is_success = 1;
    return (is_success != 0) ? 0 : -1;
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

                    if (len >= (MODBUS_WRITE_MULTI_HEADER_LENGTH + (uint16_t)(2U * num_regs) + 2U))
                    {
                    	data = &rx_buf[7];

                    	status = handle_modbus_multi_write(start_addr, num_regs, data);
                    	if (status == 0)
                    	{
                    		modbus_send_write_multi_ack(slave_addr, start_addr, num_regs);
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

    for (i = 0U; i < g_reg_table_size; ++i)
    {
    	int status = -1;
    	uint16_t addr;
    	uint16_t elemsize;
    	uint16_t total_regs;
    	const uint8_t *entry_data;
        const reg_table_entry_t *entry = &g_reg_table[i];

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
        FRAM_Request_Write_Bytes(entry->fram_offset, temp_buf, (uint16_t)(len * sizeof(uint16_t)));
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
        FRAM_Request_Write_Bytes(entry->fram_offset, temp_buf, (uint16_t)(len * sizeof(uint32_t)));
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
        FRAM_Request_Write_Bytes(entry->fram_offset, temp_buf, (uint16_t)(len * sizeof(float)));
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
    tx_buf[4] = value[0];  /* ä¸ä½ãã¤ã */
    tx_buf[5] = value[1];  /* ä¸ä½ãã¤ã */

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
