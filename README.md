# modbus-slave-regmap-generator

**modbus-slave-regmap-generator** は，Modbus スレーブ側のレジスタマップ仕様書（Excel）から，

- send/request フレーム生成用関数
- reply フレームの parse ＋値チェック処理
- レジスタアクセス用 getter/setter 関数
- 正常なMaster write／内部setter成立後の同期callback

といった，Modbus 通信まわりの定型コード一式を自動生成するツールです。

## 1.なぜ作ったか

Modbus のレジマップやプロトコル部分は仕様書で厳密に決まっている一方で，
それを C コードとして手打ちすると，

- アドレスのずれ・サイズ指定ミス
- min/max 範囲の書き間違い
- 送受信フレームのバイト数計算ミス

といった「しょぼいヒューマンエラー」がどうしても紛れ込みます。

このツールでは，**レジマップの仕様書を唯一のソース・オブ・トゥルースにする**ことを目的にしています。  
レジマップを Excel 上で修正すれば，ソフトウェアエンジニアはコードを一行も触らずに

- レジスタ定義
- アクセッサ
- 送受信ハンドラ
- 更新通知callback

を丸ごと再生成できます。  
プロトコルとして厳格に決まっている部分を自動生成に任せることで，  
エンジニアはアプリケーションロジックに集中し，思わぬミスを根本から減らすことを狙っています。

## 2.対象とする環境

本ツールは以下の環境で動作確認を行っています。

- **OS**: Windows 10 / 11（※ macOS / Linux でも Python と tkinter が動作すれば利用可能）
- **Python**: 3.10 〜 3.12
- **必要ライブラリ**
  - `pandas`
  - `openpyxl`
  - `tkinter`（GUI のファイル選択ダイアログに使用）
- **入力ファイル**: Excel（`.xlsx`）形式のレジスタ定義書  
- **出力**: C 言語（C89 相当）で実装された Modbus スレーブ向けコード一式  

※ Modbus 通信の実装そのもの（UART/SPI/RS-485 のドライバ等）は対象外です。  
  あくまで「レジマップ → コード生成」に特化したツールです。

---

## 3.クイックスタート

### 3.1. EXE版を使う

#### 3.1.1. ダウンロード
Windows 向けの実行ファイル（exe）は  
GitHub Releases ページからダウンロードできます。

➡ **[Releases ページはこちら](https://github.com/prevalmam/modbus-slave-regmap-generator/releases)**

最新バージョンの Assets から  
`modbus-slave-regmap-generator.exe` をダウンロードしてください。

#### 3.1.2. SHA-256（検証用）

配布している実行ファイルの SHA-256 ハッシュ値は  
Releases の Assets に含まれる `SHA256SUMS.txt` に記載しています。

ダウンロード後、以下のコマンドで検証できます。

```powershell
certutil -hashfile modbus-slave-regmap-generator.exe SHA256
```
出力されたハッシュ値が SHA256SUMS.txt に記載されている値と一致すれば、
ファイルが改ざんされていないことを確認できます。

### 3.2. ソースコードから使う

#### 3.2.1. git clone + pip install
次に示すコマンドを実行して，ソースコードをクローンし，pip でインストールします。

```powershell
git clone https://github.com/prevalmam/modbus-slave-regmap-generator.git
cd modbus-slave-regmap-generator
pip install .
```

#### 3.2.2. 使い方

1. Excel でレジスタ定義ファイルを準備します。
2. コマンドラインから以下を実行します。

```powershell
msrg
```
3. 起動後に Excel ファイルを選択するとExcel と同じフォルダに C/C ヘッダファイル群が出力されます。

## 4.生成コードの使い方

### 4.0 全体の流れ

生成されたコードは、以下のステップで使用します。

1. 送信ドライバ差し込み（`modbus_sender_output` 実装）
2. NVMドライバ差し込み
3. RAM実値の初期化
4. 送信処理（read/write リクエストを送る）
5. 受信処理（応答フレームを受信し、パースし、NVM 反映）
6. 値の参照・更新（getter/setter でアプリ側からアクセス）
7. 更新通知（Master write／内部setter成立後のcallback処理）
---

### 4.1 送信ドライバ差し込み（`modbus_sender_output` 実装）

生成コード一式のうち、実機へフレームを吐き出す処理だけはユーザー側で書き足す必要があります。`modbus_sender_generic.c` 冒頭には次のような extern 宣言だけが置かれています。

```c
extern void modbus_sender_output(const uint8_t *data, uint16_t len);
```

この関数に UART / RS-485 / TCP など、実際の送信ドライバを呼び出すコードを実装してください。最低限の手順は以下のとおりです。

1. 生成物中から上記シグネチャのスタブ（もしくはヘッダ宣言）を探し、自プロジェクトの送信モジュールにコピーする。
2. TX イネーブルや CRC 追加など、物理層に必要な処理を行ったうえで `data` バッファを `len` バイト分送信する。
3. 送信完了待ちや半二重制御（DE/RE 制御）が必要な場合は、この関数内で完結させる。

参考までに、RS-485 ＋ DMA 送信を想定した最小実装例は以下です。

```c
void modbus_sender_output(const uint8_t *data, uint16_t len)
{
    rs485_set_tx_enable(true);
    uart_dma_send(data, len);
    uart_dma_wait_for_complete();
    rs485_set_tx_enable(false);
}
```

このフックを埋めておけば、以降の送信 API（read/write リクエスト）はすべて生成コードだけで完結します。

### 4.2 NVMドライバ差し込み

受信処理側の `modbus_parser.c` では、Write Single (0x06)／Write Multiple (0x10) の各パスで RAM を更新したあと、Excel の RegisterTable で `NVM_Offset` にオフセットを指定したエントリについて `NVM_Request_Write_Bytes()` を呼び出します。アプリ側から `set_xxx()` で値を更新した場合も、同じく `NVM_Offset` が有効なエントリは NVM に反映されます。`NVM_Offset` は NVM 領域先頭からのバイトオフセットで、物理番地そのものではありません。生成コードは次の外部関数を呼び出すため、実機依存の NVM（FRAM／FLASH／EEPROM など）ドライバをプロジェクト側で実装してください。

```c
extern void NVM_Request_Write_Bytes(uint16_t offset,
                                    const uint8_t *data,
                                    uint16_t length);
```

実装時のポイント:

1. `offset` は NVM 領域先頭からのバイトオフセットです。RegisterTable の `NVM_Offset` に `0x0000`、`0x0004`、`16` のように明示指定します。NVM に保存しないエントリは `NVM_Offset` に `-` を指定します。
2. `data` は RAM 上の値をバイト列として見たものです。setter では 1 要素分、Modbus Write 受信では対象ブロック分が渡されます。
3. `length` は書き込む総バイト数です。

例えば I2C 接続の FRAM へブロック書き込みする場合:

```c
void NVM_Request_Write_Bytes(uint16_t offset,
                             const uint8_t *data,
                             uint16_t length)
{
    fram_lock_bus();
    fram_begin_transaction();
    fram_write(offset, data, length);
    fram_end_transaction();
    fram_unlock_bus();
}
```

もしプロジェクトで NVM 書き込みを使わない場合でも、リンカエラーを防ぐためにシグネチャどおりのスタブだけは用意してください。スタブ内で全引数を `(void)` キャストしておけば未使用警告も抑止できます。

```c
void NVM_Request_Write_Bytes(uint16_t offset,
                             const uint8_t *data,
                             uint16_t length)
{
    (void)offset;
    (void)data;
    (void)length;
}
```


### 4.3 初期化

起動時に行うべき初期処理は、RAM の実値を初期化することです。

**RAM の実値を `g_reg_table_slave` 経由でセットする** — NVM/別ストレージからの復元あるいはデフォルト値の適用を、生成済み getter/setter ではなく `g_reg_table_slave` の `ram_ptr` と `size` を使って一括処理するのが最も手軽でミスがありません。永続領域のデータがない場合は、`default_value` をコピーするだけで RAM が仕様書どおりに初期化されます。

    ```c
    static void load_reg_defaults(void)
    {
        for (uint16_t i = 0; i < g_reg_table_slave_size; ++i)
        {
            const reg_table_slave_entry_t *e = &g_reg_table_slave[i];
            uint16_t elem_size = (uint16_t)(e->size / e->length);
            for (uint16_t j = 0; j < e->length; ++j)
            {
                const uint8_t *src = ((const uint8_t *)e->default_value) + (j * elem_size);
                uint8_t *dst = ((uint8_t *)e->ram_ptr) + (j * elem_size);
                (void)memcpy(dst, src, elem_size);
            }
        }
    }
    ```

write通知を含むその他の生成ファイルは静的領域がゼロ初期化されるため、追加の初期化は不要です。

### 4.4 送信処理（Request の送信）

生成コード側では、各レジスタブロックごとに **read 系 (`modbus_sender_req_*`)** と **write 系 (`modbus_sender_set_*`)** の 2 本立て API が自動生成されます。`MODBUS_SLAVE_ADDR` は Excel の Config シートから取得され、すべての送信フレームに自動で組み込まれます。

#### 4.4.1 Read Request（0x03）
- 監視したいブロックに対して `modbus_sender_req_<VarName>()` を呼び出すだけで、Function Code 0x03 のフレームが生成されます。
- 送信バッファは `modbus_sender_output()` へそのまま受け渡されるため、ユーザーは UART／RS-485 ドライバ内で実際の TX を完了させます。

```c
void poll_uptime_sec(void)
{
    modbus_sender_req_uptime_sec();         /* Excel で定義した block 名に応じた関数名が生成される */
}
```

#### 4.4.2 Write Request（0x10）

- アプリ側で RAM 上の値を setter で更新したあと、`modbus_sender_set_<VarName>()` を呼び出すと Function Code 0x10（Write Multiple Registers）が組み立てられます。
- データ型ごとに `modbus_sender_generic_u16/u32/float()` が内部で選択され、必要なバイト長や配列展開をすべて自動で行います。
- 配列レジスタの場合もブロック全体を 1 パケットで送るのが基本です。

```c
void update_device_mode(uint16_t new_value)
{
    set_device_mode(new_value);             /* RAM を最新値で更新 */
    modbus_sender_set_device_mode();        /* 直近ブロックを丸ごと 0x10 で送信 */
}
```

---

### 4.5 受信処理とパースと NVM 反映

応答フレームを受信したら、reply_handler に渡すだけで完了します。

    if (rx_complete) {
        modbus_reply_handler_slave(rx_buf, rx_len);
    }

パース後に自動的に行われる処理：

- CRC の検証
- Function Code の判定
- レジスタ値の展開
- Min/Max チェック
- RAM（g_reg_table_slave[]）への反映
- NVM 書き込み要求（値が変化し、NVM_Offset にオフセットを指定した場合）

---

### 4.6 レジスタアクセス（getter / setter）

#### 4.6.1 値の読み出し（getter）

    uint16_t mode = get_device_mode();
    float process_value = get_process_value();

#### 4.6.2 値の書き換え（setter）

    set_device_mode(2);
    set_process_value(36.5f);

setter は min/max チェックを自動で行います。範囲外の値をセットしようとした場合は何も変更されません。値が現在値と異なる場合は RAM を更新し、`NVM_Offset` が有効なエントリでは `NVM_Request_Write_Bytes()` で NVM にも反映します。同じ値をセットした場合は成功扱いで戻りますが、RAM/NVM への書き込みは行いません。

#### 4.6.3 文字列レジスタのアクセス

`Type` に `string` または `CHAR` を指定したレジスタでは、数値用の min/max 取得関数は生成されず、文字列専用のアクセサが生成されます。

```c
char name_copy[MODBUS_device_name_BUFFER_SIZE];
if (get_device_name_copy(name_copy, sizeof(name_copy)) != 0)
{
    /* name_copy は NUL 終端されているため、C の文字列関数へ渡せる。 */
}

set_device_name("SENSOR-A");
```

生成される定数と関数は次のとおりです。定数名の `<VarName>` 部分は、RegisterTable に記述した大文字・小文字をそのまま保持します。

| 定数 | 用途 |
|------|------|
| `MODBUS_<VarName>_MAX_LENGTH` | 設定可能な最大文字数。ASCII printable 文字列では `ArrayLen` と同じ値になる |
| `MODBUS_<VarName>_BUFFER_SIZE` | 最大長の文字列と終端 NUL を格納できるバッファサイズ。`MAX_LENGTH + 1U` として生成される |

| 関数 | 用途 |
|------|------|
| `int get_<VarName>_copy(char *dst, uint16_t dst_size)` | 固定長フィールドを呼び出し側へコピーし、末尾に NUL を追加する |
| `int set_<VarName>(const char *value)` | NUL 終端された C 文字列を検証して固定長フィールドへ反映し、必要に応じて NVM に保存する |

`set_<VarName>()` は ASCII printable 文字のみを許可し、最大 `MODBUS_<VarName>_MAX_LENGTH` 文字まで設定できます。`get_<VarName>_copy()` のコピー先には `MODBUS_<VarName>_BUFFER_SIZE` byte 以上を確保してください。

内部 RAM は `ArrayLen` byte の固定長フィールドであり、最大長まで文字が格納されている場合はフィールド内に NUL がありません。そのため、内部 RAM や Modbus から読み出した固定長データを `strlen()`、`strcmp()`、`printf("%s", ...)` などの C 標準文字列関数へ直接渡してはいけません。標準文字列関数を使用する場合は、必ず `get_<VarName>_copy()` で `ArrayLen + 1` byte 以上のバッファへコピーし、NUL 終端された C 文字列に変換してから渡してください。

#### 4.6.4 下限値・上限値の取得

    uint16_t min_mode = get_device_mode_min();
    uint16_t max_mode = get_device_mode_max();
---

### 4.7 更新通知

RegisterTableの`UPDATE_NOTIFY`を`TRUE`にすると、正常に受理したModbus
Master writeと、正常終了した生成setterの両方から同期的に呼び出すユーザー
callbackの宣言と呼出コードが生成されます。これは値変化の通知ではなく、正常な
更新操作の成立通知です。現在値と同じ値をwriteまたはsetした場合も毎回通知します。

```c
typedef enum
{
    MODBUS_REG_UPDATE_SOURCE_MASTER_WRITE = 1,
    MODBUS_REG_UPDATE_SOURCE_INTERNAL_SET = 2
} modbus_reg_update_source_t;

void modbus_user_device_mode_updated(modbus_reg_update_source_t source)
{
    if (source == MODBUS_REG_UPDATE_SOURCE_MASTER_WRITE)
    {
        app_apply_device_mode(get_device_mode());
    }
}
```

callbackにはweakな空実装を生成しません。`UPDATE_NOTIFY=TRUE`にしたすべての
変数について、ユーザープロジェクト側で`modbus_user_<VarName>_updated()`を
実装してください。未実装の場合はリンクエラーになります。

#### Master writeの呼出順序

Write Single（0x06）／Write Multiple（0x10）が正常に受理された場合、生成
parserは次の順序で処理します。

1. 書込み対象、アクセス権、`BUSY_REJECT`、Min/Max、`WRITE_CHECK`、
   `GROUP_VALIDATE`を検証する。
2. 対象をRAMへ反映し、値が変化したNVM対象には
   `NVM_Request_Write_Bytes()`を呼ぶ。
3. `ModbusPort_RequestSend()`へ正常ACKの送信を要求する。
4. `UPDATE_NOTIFY=TRUE`の対象ごとに、
   `MODBUS_REG_UPDATE_SOURCE_MASTER_WRITE`を渡してcallbackを同期的に呼ぶ。
5. すべてのcallbackがreturnした後、`modbus_parse_and_reply()`がreturnする。

`ModbusPort_RequestSend()`のreturnは、UARTやDMAによる物理的なACK送信完了を
意味しません。生成器が保証するのは、ACKの**送信要求後**にcallbackを呼ぶ
ことまでです。

Write Multipleでは、全対象をコミットしてACK送信を要求した後、対象変数を
レジスタアドレス昇順に1回ずつ通知します。最初のcallbackから、同じ要求に
含まれるほかの変数も更新後の値として参照できます。

拒否したwriteでは正常ACKも更新callbackも呼びません。callbackが呼ばれる
時点では書込み受理とACK送信要求が完了しているため、callbackからwriteを
拒否することはできません。拒否条件は`BUSY_REJECT`、`WRITE_CHECK`、
`GROUP_VALIDATE`へ実装してください。

#### 内部setterの呼出順序

生成された`set_<VarName>()`は、引数検証に成功した後、必要ならRAM更新と
NVM書込み要求を行い、`MODBUS_REG_UPDATE_SOURCE_INTERNAL_SET`を渡して
callbackを同期的に呼びます。callbackがreturnした後にsetterが`1`を返します。

- 同値setでもcallbackを呼びますが、RAM更新とNVM書込み要求は省略します。
- 範囲外の値、不正な配列index、不正な文字列などでsetterが`0`を返す場合は
  callbackを呼びません。
- `set_<VarName>_masked()`は通常setterへ委譲するため、通知は1回です。
- 配列は要素単位ではなく変数単位で通知します。
- `UPDATE_NOTIFY=FALSE`のsetterはcallbackを呼びません。

#### callback利用上の注意

callbackはparserまたはsetterの呼出元コンテキストで同期実行されます。生成器は
キューイング、タスク切替、排他制御、再入防止、実行時間監視を行いません。

- callbackが長時間ブロックすると、parserまたはsetterもreturnしません。
- callbackから`UPDATE_NOTIFY=TRUE`の別変数のsetterを呼ぶと、そのcallbackへ
  同期的に入ります。深いcallbackチェーンや循環呼出しに注意してください。
- callbackから同じ変数のsetterを呼ぶと、同値でも再通知するため無限再帰に
  なります。
- Write Multipleのcallbackから、後でMaster write通知される別変数のsetterを
  呼んだ場合、その変数には`INTERNAL_SET`、続いて`MASTER_WRITE`のcallbackが
  呼ばれる場合があります。
- callback内のgetterは、Master write直後のsnapshotではなく、呼出時点の
  最新RAM値を返します。

baudrate、parity、UART再初期化、再起動など、ACK送信完了前に行うと通信へ
影響する処理は、callbackでは要求フラグだけを立て、UARTのTX完了を確認して
から実行してください。

```c
void modbus_user_modbus_baudrate_updated(modbus_reg_update_source_t source)
{
    (void)source;
    s_modbus_config_update_requested = 1U;
}
```

`NVM_Request_Write_Bytes()`には完了結果がないため、callbackはNVM永続化完了を
保証しません。また、生成RAM変数や`g_reg_table_slave[].ram_ptr`へ直接代入した
場合は通知しません。通知対象は正常なMaster writeと生成setterだけです。


## 5.詳細仕様

### 5.1.入力 Excel のフォーマット概要

本ツールは、次のような構造のレジスタ定義書（Excel）を前提としています。

#### 5.1.1.RegisterTable シート

| 列名 | 例 | 説明 |
|------|------------|-------------------------------------------|
| `Reg_Addr` | `1000` | Modbus アドレス(10進数) |
| `VarName` | `device_mode` | レジスタの論理名（C 変数名にも使用） |
| `Type` | `uint16_t` / `uint32_t` / `float` / `string` / `CHAR` / `reserved` | 型（C コード生成に利用） |
| `ArrayLen` | `1` / `NUM_DISCRETE_INPUTS` | 配列長。複数の場合は連続アドレスを自動展開 |
| `Access` | `RW` / `RO` | Modbus 経由のアクセス権 |
| `Min` | `0` | 許容最小値（境界チェックで使用） |
| `Max` | `3` | 許容最大値（境界チェックで使用） |
| `Default` | `0` | 初期値 |
| `NVM_Offset` | `-` / `0x0000` / `16` | `-` の場合は NVM に保存しない。数値の場合は NVM 領域先頭からのバイトオフセット |
| `UPDATE_NOTIFY` | `TRUE`/`FALSE` | TRUE の場合、正常なMaster write／内部setter成立後に同期callbackを呼ぶ |
| `BUSY_REJECT` | `TRUE`/`FALSE` | TRUE の場合、レジスタ単位のbusy状態によるModbus書込み拒否APIを生成する |
| `WRITE_CHECK` | `TRUE`/`FALSE` | TRUE の場合、型付きユーザー書込み判定関数を呼び出す |
| `GROUP_VALIDATE` | `-` / グループ名 | 同じグループ名のレジスタを仮更新後の値で検証する |

`NVM_Offset` は空欄禁止です。保存しない場合は `-`、保存する場合は 10進数または `0x` 始まりの16進数を指定してください。指定した NVM 範囲が `NVM_SIZE` を超える場合、または他のエントリと重複する場合はエラーになります。オフセットが型サイズ境界にそろっていない場合は警告しますが、生成は継続します。

`UPDATE_NOTIFY`、`BUSY_REJECT`、`WRITE_CHECK` は必須列で、値は大文字の `TRUE` または `FALSE` のみ指定できます。空欄、`-`、小文字表記はエラーです。`GROUP_VALIDATE` も必須列で、未使用時は `-`、使用時はC識別子として有効なグループ名を指定します。`UPDATE_NOTIFY=TRUE`はread-onlyレジスタにも指定できます。その場合は内部setterからだけ通知されます。

##### 文字列レジスタ

文字列を扱う場合は、`Type` に `string` または `CHAR` を指定します。RAM、NVM、Modbus 上では `ArrayLen` byte の固定長フィールドとして扱い、Modbus 上は 1 register に 2 byte ずつ、high byte → low byte の順で格納されます。

| Reg_Addr | VarName | Type | ArrayLen | Access | Min | Max | Default | NVM_Offset | UPDATE_NOTIFY | BUSY_REJECT | WRITE_CHECK | GROUP_VALIDATE |
|---------:|---------|------|---------:|--------|-----|-----|---------|------------|------|-------------|-------------|----------------|
| `1000` | `device_name` | `string` | `16` | `RW` | `-` | `-` | `SENSOR-A` | `0x0000` | `TRUE` | `FALSE` | `TRUE` | `DEVICE` |

文字列レジスタには次の制約があります。

- `ArrayLen` は固定長フィールドのサイズであると同時に、設定可能な最大文字数です。`ArrayLen=16` の場合、RAM、NVM、Modbus の占有サイズは 16 byte で、最大16文字まで設定できます。
- stringごとに`MODBUS_<VarName>_MAX_LENGTH`と`MODBUS_<VarName>_BUFFER_SIZE`が`modbus_reg_access_slave.h`へ生成されます。アプリ側の最大文字数やC文字列バッファサイズには、この定数を使用してください。
- `ArrayLen` は偶数のみ許可します。`15` のような奇数を指定するとエラーで生成を中止します。
- 文字数が `ArrayLen` 未満の場合は、文字列の後ろを `0x00` で埋めます。文字数がちょうど `ArrayLen` の場合は、フィールド内の全 byte を文字として使用し、フィールド内に終端 NUL は格納しません。
- `Default` は ASCII printable 文字のみ指定できます。空欄は許可しません（入力漏れと区別するため）。
- `Default` を空文字列にしたい場合は `-` を指定してください。リテラルの `-` という文字列をDefaultにしたい場合は `"-"` のようにダブルクォートで囲みます。
- `Min` と `Max` は必ず `-` を指定してください。空欄は許可しません。
- `UPDATE_NOTIFY`を`TRUE`にすると、文字列レジスタへの正常なMaster writeと内部setterの両方を通知できます。
- Modbus Write では、途中に NUL がある場合はNUL以降がすべて `0x00` paddingであるデータを受け付けます。NULがない場合は、全 `ArrayLen` byteがASCII printable文字であれば最大長の文字列として受け付けます。

固定長フィールドは、最大長まで文字が格納されている場合にNUL終端されません。内部RAMやModbusデータをC文字列として直接扱わず、`strlen()`、`strcmp()`、`printf("%s", ...)`などへ渡す前に、`ArrayLen + 1` byte以上のバッファへコピーして末尾にNULを追加してください。生成される`get_<VarName>_copy()`はこの変換を行います。

生成される`modbus_string_field_is_valid()`は、固定長フィールドが「ASCII printable文字＋`0x00` padding」または「全byteがASCII printable文字」のどちらかであることを検証します。`modbus_string_field_length()`は先頭のNUL位置、NULがなければフィールドサイズを論理文字数として返します。ユーザープロジェクト側でNVMから復元する場合も、この検証関数を使用して`ArrayLen` byteだけをRAMへコピーしてください。NVM上に終端用の追加byteは保存しません。

##### 予約レジスタ（reserved）

連続するアドレスブロックを master が一括 Read する際、途中に何も割り当てていないアドレスが存在する場合は `Type` に `reserved` を指定します（大文字小文字は問いません）。

| Reg_Addr | VarName | Type | ArrayLen | Access | Min | Max | Default | NVM_Offset | UPDATE_NOTIFY | BUSY_REJECT | WRITE_CHECK | GROUP_VALIDATE |
|---------:|---------|------|---------:|--------|-----|-----|---------|------------|------|-------------|-------------|----------------|
| `1173` | `reserved_1173` | `reserved` | `2` | `-` | `-` | `-` | `-` | `-` | `FALSE` | `FALSE` | `FALSE` | `-` |

- `ArrayLen` は **Modbus レジスタ数**（1 = 2 byte）で指定します。`2` であれば 1173〜1174 の 2 レジスタ分を予約します。
- `Access` / `Min` / `Max` / `Default` / `NVM_Offset` は `-`、`UPDATE_NOTIFY` / `BUSY_REJECT` / `WRITE_CHECK` は `FALSE`、`GROUP_VALIDATE` は `-` を指定してください。
- `VarName` は記述必須ですが、C 識別子の制約はありません（ドキュメント用途）。

**生成物への影響**

| 生成物 | 動作 |
|--------|------|
| RAM 変数 | 生成しない |
| `default_` / `min_` / `max_` 定数 | 生成しない |
| `get_` / `set_` アクセス関数 | 生成しない |
| `g_reg_table_slave[]` エントリ | 生成する（`ram_ptr = NULL`、`REG_TYPE_RESERVED`） |
| `MODBUS_IDX_` マクロ | 生成する（テーブルインデックスとの対応を維持するため） |

**Read 時の挙動**

| master の要求 | スレーブの応答 |
|-------------|------|
| reserved を含む範囲の一括 Read | reserved アドレス部分は `0x0000` で正常返答 |
| reserved アドレス範囲に一致しない Read（例：2 レジスタ占有の reserved に対し 1 レジスタ単位で Read） | `ILLEGAL_DATA_ADDRESS` exception |
| 登録されていないアドレスへの Read | `ILLEGAL_DATA_ADDRESS` exception |

※プロジェクトに応じて追加カラムは自由に拡張できます。  

#### 5.1.2LengthDefs シート（任意）

| 列名 | 説明 |
|------|-------------------------------------------|
| `Macro_Name` | ArrayLen のマクロ名 |
| `Value` | マクロの値 |


![LengthDefs シートの例](images/format_LengthDefs.png)

※プロジェクトに応じて追加カラムは自由に拡張できます。  

#### 5.1.3.Config シート

標準フォーマットでは C5セルに `NVM_SIZE`、D5セルに NVM 領域のサイズ（10進数）を指定します。`NVM_SIZE` は `NVM_Offset` の範囲チェックと、生成コード上の未使用値 `NVM_OFFSET_UNUSED` の定義に使われます。指定可能な範囲は `1` から `65535` です。

標準フォーマットでは C6セルに `SLAVE_ADDR`、D6セルに Modbus スレーブアドレス（10進数）を指定します。

![Config シートの例](images/format_Config.png)

---

### 5.2.書込みガード

生成コードはModbus書込みを次の順序で処理します。

1. 書込み範囲、アクセス権、レジスタ全体が含まれることを確認
2. `BUSY_REJECT`を確認
3. Min/Maxおよび文字列形式を確認
4. `WRITE_CHECK`を呼び出す
5. 仮更新後のpointer snapshotを作成
6. 関係する`GROUP_VALIDATE`を呼び出す
7. すべて成功した場合だけRAMへ反映し、必要なNVM書込みを要求

配列、文字列、`uint32_t`、`float`を含め、Excelの1エントリの一部だけを書き込む要求は拒否します。複数レジスタ書込みで検証が失敗した場合、RAMとNVM書込み要求には一切反映しません。

検証成功後はRAMを更新してから`NVM_Request_Write_Bytes()`を呼び出します。このNVM APIには戻り値がないため、NVMドライバ内部の失敗、キュー枯渇、書込み中の電源断まで含めた永続化のatomicityは保証しません。

#### BUSY_REJECT

`BUSY_REJECT=TRUE`のレジスタには次のAPIを生成します。

```c
MB_BOOL modbus_get_busy_reject_mode(void);
void modbus_set_busy_reject_mode(MB_BOOL busy);
```

busy中のModbus書込みには`MODBUS_EXCEPTION_SLAVE_DEVICE_BUSY`（`0x06`）を返します。busy状態は対象レジスタごとのbitで保持します。

#### WRITE_CHECK

`WRITE_CHECK=TRUE`のレジスタには型に応じたextern宣言を生成します。これらの関数はユーザープロジェクト側で実装してください。

```c
/* スカラー */
modbus_write_result_t modbus_user_write_check_mode(
    uint16_t current_value,
    uint16_t new_value);

/* 配列 */
modbus_write_result_t modbus_user_write_check_table(
    const uint16_t current_value[],
    const uint16_t new_value[],
    uint16_t count);

/* 固定長文字列 */
modbus_write_result_t modbus_user_write_check_name(
    const modbus_string_view_t *current_value,
    const modbus_string_view_t *new_value);
```

`modbus_string_view_t`はNUL終端を前提としない固定長文字列への参照と論理文字数を保持します。文字列用WRITE_CHECKでは`data[0]`から`data[length - 1]`までを検証し、`data`をC標準文字列関数へ直接渡さないでください。

同値書込みの場合もWRITE_CHECKを呼び出します。`MODBUS_WRITE_OK`以外を返すと書込みを拒否し、その理由をModbus exceptionとして返します。

#### GROUP_VALIDATEとpointer snapshot

同じ`GROUP_VALIDATE`名を持つレジスタのいずれかが書込み範囲に含まれる場合、対応する関数を1回呼び出します。

```c
modbus_write_result_t modbus_user_group_validate_lower_upper(
    const modbus_reg_snapshot_t *after)
{
    return (*after->lower <= *after->upper)
        ? MODBUS_WRITE_OK
        : MODBUS_WRITE_ILLEGAL_VALUE;
}
```

`modbus_reg_snapshot_t`はGROUP_VALIDATEに参加する各レジスタへの型付きconst pointerまたは文字列viewを保持します。書込み対象はエンディアン変換済み・アラインメント済みの仮更新値、対象外は現在のRAM値を指します。配列と文字列は次のように参照できます。

```c
uint16_t first = after->table[0];
char first_char = after->name.data[0];
uint16_t name_length = after->name.length;
```

snapshotとその各pointer/viewはGROUP_VALIDATE callbackの実行中だけ有効です。callback終了後に保存または参照してはいけません。

生成コードはC89互換のため、`bool`と`<stdbool.h>`を使用しません。

```c
typedef uint8_t MB_BOOL;
typedef uint8_t modbus_write_result_t;

#define MB_FALSE ((MB_BOOL)0U)
#define MB_TRUE  ((MB_BOOL)1U)

#define MODBUS_WRITE_OK              ((modbus_write_result_t)0x00U)
#define MODBUS_WRITE_ILLEGAL_ADDRESS ((modbus_write_result_t)0x02U)
#define MODBUS_WRITE_ILLEGAL_VALUE   ((modbus_write_result_t)0x03U)
#define MODBUS_WRITE_DEVICE_FAILURE  ((modbus_write_result_t)0x04U)
#define MODBUS_WRITE_DEVICE_BUSY     ((modbus_write_result_t)0x06U)
```

WRITE_CHECKとGROUP_VALIDATEが返せる値は上記の5種類です。それ以外の値を返した場合は、生成parserが`MODBUS_WRITE_DEVICE_FAILURE`へ変換します。複数のcallbackが対象になる場合は、WRITE_CHECKをアドレス順、GROUP_VALIDATEをExcel上のグループ初出順に評価し、最初に返されたエラーを採用します。

書込みscratchはModbus最大データ長と同じ252 byteを静的に確保します。受信処理とBUSY_REJECT setterは再入不可であり、main loopから直列に呼び出す前提です。

---

### 5.3.生成されるファイル一覧

本ツール実行後、選択した Excel と同じフォルダに以下の C/C ヘッダファイル群が出力されます。

#### 5.3.1.レジスタ定義・アクセサ
| ファイル | 役割 |
|---------|--------------------------------------------|
| `modbus_reg_map_slave.c/h` | レジスタのメタ情報テーブル（型、アドレス、Min/Max/Default、RAM 参照など） |
| `modbus_reg_idx_slave.h` | `MODBUS_IDX_***` マクロで各レジスタのインデックスを一元管理 |
| `modbus_reg_access_slave.c/h` | getter / setter / min-max 取得関数、およびビットマスク付き setter |
| `modbus_reg_write_guard_slave.c/h` | `MB_BOOL`、BUSY_REJECT API、WRITE_CHECK/GROUP_VALIDATE宣言、typed snapshot |

#### 5.3.2.更新通知

| ファイル | 役割 |
|---------|--------------------------------------------|
| `modbus_reg_update_notify_slave.c/h` | `UPDATE_NOTIFY=TRUE`のレジスタに対する同期callback宣言と通知振り分け |

旧schemaの`modbus_reg_edge_slave.c/h`または`modbus_reg_write_event_slave.c/h`が
出力先に存在する場合は、再生成時に削除されます。`EDGE`と`WRITE_NOTIFY`列、
および旧consume APIとの互換性はありません。

#### 5.3.3.受信処理

| ファイル | 役割 |
|---------|--------------------------------------------|
| `modbus_parser.c/h` | Read Holding Registers 応答の CRC 検証、値取り出し、レンジチェック、RAM 更新 |
