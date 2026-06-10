# modbus-slave-regmap-generator

**modbus-slave-regmap-generator** は，Modbus スレーブ側のレジスタマップ仕様書（Excel）から，

- send/request フレーム生成用関数
- reply フレームの parse ＋値チェック処理
- レジスタアクセス用 getter/setter 関数
- ビット変化／値変化を検出するエッジ検出関数  
  （rising/falling/toggled など）

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
- エッジ検出処理

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
3. 初期化（エッジ検出関数の初期化）
4. 送信処理（read/write リクエストを送る）
5. 受信処理（応答フレームを受信し、パースし、NVM 反映）
6. 値の参照・更新（getter/setter でアプリ側からアクセス）
7. エッジ検出（値の変化を検出し、アプリイベントとして処理）
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

起動時に行うべき初期処理は次の 2 ステップに集約されます。

1. **RAM の実値を `g_reg_table_slave` 経由でセットする** — NVM/別ストレージからの復元あるいはデフォルト値の適用を、生成済み getter/setter ではなく `g_reg_table_slave` の `ram_ptr` と `size` を使って一括処理するのが最も手軽でミスがありません。永続領域のデータがない場合は、`default_value` をコピーするだけで RAM が仕様書どおりに初期化されます。

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

2. **`modbus_reg_edge_init()` でエッジ検出のプリロードを行う** — 上記の RAM セット後にこの関数を 1 回呼ぶと、RegisterTable で `EDGE` 列を `TRUE` にしたエッジ検出器が「現在値＝前回値」で同期され、初回ポーリング時の誤検知を防げます。以降は周期タスクや受信ハンドラから各 `detect_*` 関数をそのまま利用できます。

```c
void app_init(void)
{
    load_reg_defaults();          /* RAM に初期値を展開 */
    modbus_reg_edge_init();       /* エッジ検出の前回値をプリロード */
}
```

その他の生成ファイル（reg_map/access/sender/reply_handler 等）は静的データや純粋関数のみで構成されているため、追加の初期化は不要です。

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
const char *name = get_device_name();

char name_copy[16];
if (get_device_name_copy(name_copy, sizeof(name_copy)) != 0)
{
    /* name_copy を使用 */
}

set_device_name("SENSOR-A");
```

生成される関数は次の 3 種類です。

| 関数 | 用途 |
|------|------|
| `const char *get_<VarName>(void)` | 内部 RAM 上の NUL 終端文字列を直接参照する |
| `int get_<VarName>_copy(char *dst, uint16_t dst_size)` | 呼び出し側のバッファへ文字列をコピーする |
| `int set_<VarName>(const char *value)` | 文字列を検証して RAM に反映し、必要に応じて NVM に保存する |

`set_<VarName>()` は ASCII printable 文字のみを許可します。`ArrayLen` は C の `char` バッファサイズなので、設定可能な文字数は最大 `ArrayLen - 1` 文字です。

#### 4.6.4 下限値・上限値の取得

    uint16_t min_mode = get_device_mode_min();
    uint16_t max_mode = get_device_mode_max();
---

### 4.7 エッジ検出（値変化の検知）

#### 4.7.1 立ち上がり検出の例（単体値）

```c
    if (detect_device_mode_rising(0xffff)) {
        // 0 → 1 に変化したときだけ実行
    }
```

特定のビットマスクを指定することも可能：

#### 4.7.2 立ち下がり検出の例（単体値）

```c
    if (detect_device_mode_falling(0xffff)) {
        // 1 → 0 に変化したときだけ実行
    }
```

#### 4.7.3 トグル検出の例（配列値）

```c
    if (detect_discrete_inputs_toggled(0x0003)) {
        // ビット 0 またはビット 1 が変化したときだけ実行
    }
```


## 5.詳細仕様

### 5.1.入力 Excel のフォーマット概要

本ツールは、次のような構造のレジスタ定義書（Excel）を前提としています。

#### 5.1.1.RegisterTable シート

| 列名 | 例 | 説明 |
|------|------------|-------------------------------------------|
| `Reg_Addr` | `1000` | Modbus アドレス(10進数) |
| `VarName` | `device_mode` | レジスタの論理名（C 変数名にも使用） |
| `Type` | `uint16_t` / `uint32_t` / `float` / `string` / `CHAR` | 型（C コード生成に利用） |
| `ArrayLen` | `1` / `NUM_DISCRETE_INPUTS` | 配列長。複数の場合は連続アドレスを自動展開 |
| `Access` | `RW` / `RO` | Modbus 経由のアクセス権 |
| `Min` | `0` | 許容最小値（境界チェックで使用） |
| `Max` | `3` | 許容最大値（境界チェックで使用） |
| `Default` | `0` | 初期値 |
| `NVM_Offset` | `-` / `0x0000` / `16` | `-` の場合は NVM に保存しない。数値の場合は NVM 領域先頭からのバイトオフセット |
| `EDGE` | `TRUE`/`FALSE` | TRUE の場合、該当レジスタのエッジ検出関数を生成する |

`NVM_Offset` は空欄禁止です。保存しない場合は `-`、保存する場合は 10進数または `0x` 始まりの16進数を指定してください。指定した NVM 範囲が `NVM_SIZE` を超える場合、または他のエントリと重複する場合はエラーになります。オフセットが型サイズ境界にそろっていない場合は警告しますが、生成は継続します。

##### 文字列レジスタ

文字列を扱う場合は、`Type` に `string` または `CHAR` を指定します。C コード上は固定長の `char` 配列として生成され、Modbus 上は 1 register に 2 byte ずつ、high byte → low byte の順で格納されます。

| Reg_Addr | VarName | Type | ArrayLen | Access | Min | Max | Default | NVM_Offset | EDGE |
|---------:|---------|------|---------:|--------|-----|-----|---------|------------|------|
| `1000` | `device_name` | `string` | `16` | `RW` | `-` | `-` | `SENSOR-A` | `0x0000` | `FALSE` |

文字列レジスタには次の制約があります。

- `ArrayLen` はバッファサイズ byte です。`ArrayLen=16` の場合、生成される RAM は `char device_name[16]` です。
- `ArrayLen` は偶数のみ許可します。`15` のような奇数を指定するとエラーで生成を中止します。
- 設定可能な文字数は最大 `ArrayLen - 1` 文字です。残りの領域は `0x00` で埋めます。
- `Default` は ASCII printable 文字のみ指定できます。
- `Min` と `Max` は必ず `-` を指定してください。空欄は許可しません。
- `EDGE` は `FALSE` のみ指定できます。文字列レジスタで `TRUE` を指定するとエラーになります。
- Modbus Write で受信した文字列は、NUL 終端があり、NUL 以降がすべて `0x00` padding である場合だけ受け付けます。

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

### 5.2.生成されるファイル一覧

本ツール実行後、選択した Excel と同じフォルダに以下の C/C ヘッダファイル群が出力されます。

#### 5.2.1.レジスタ定義・アクセサ
| ファイル | 役割 |
|---------|--------------------------------------------|
| `modbus_reg_map_slave.c/h` | レジスタのメタ情報テーブル（型、アドレス、Min/Max/Default、RAM 参照など） |
| `modbus_reg_idx_slave.h` | `MODBUS_IDX_***` マクロで各レジスタのインデックスを一元管理 |
| `modbus_reg_access_slave.c/h` | getter / setter / min-max 取得関数、およびビットマスク付き setter |

#### 5.2.2.エッジ検出

| ファイル | 役割 |
|---------|--------------------------------------------|
| `modbus_reg_edge_slave.c/h` | `EDGE=TRUE` のレジスタに対する変化検出（rising / falling / toggled / changed）関数群 |

#### 5.2.3.受信処理

| ファイル | 役割 |
|---------|--------------------------------------------|
| `modbus_parser.c/h` | Read Holding Registers 応答の CRC 検証、値取り出し、レンジチェック、RAM 更新 |
