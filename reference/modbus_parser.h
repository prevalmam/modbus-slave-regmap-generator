/*
 * modbus_parser.h
 *
 *  Created on: 2025/05/22
 *      Author: 1225190
 */

#ifndef MODBUSLAYER_MODBUS_PARSER_H_
#define MODBUSLAYER_MODBUS_PARSER_H_

#include <stdint.h>

#define MODBUS_EXC_SLAVE_DEVICE_BUSY  0x06U

/**
 * @brief FRAM書き込み要求。実装は別モジュールで提供する。
 */
extern void FRAM_Request_Write_Bytes(uint16_t offset,
                                       const uint8_t *data,
                                       uint16_t length);

/**
 * @brief Modbus応答フレーム送信要求。実装はUART/HAL側で提供する。
 */
extern void ModbusPort_RequestSend(const uint8_t *frame, uint16_t length);

void modbus_send_exception_response(uint8_t slave_addr, uint8_t function_code, uint8_t exception_code);
void modbus_parse_and_reply(const uint8_t *rx_buf, uint16_t len);

#endif /* MODBUSLAYER_MODBUS_PARSER_H_ */
