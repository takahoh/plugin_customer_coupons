# plugin_customer_coupons

SFRA (Storefront Reference Architecture) 向けプラグインカートリッジ。
**マイページで「顧客が使えるクーポン一覧」を表示する**、B2C Commerce の標準では提供されていない機能を追加します。

- 標準の Account ダッシュボードに「利用可能なクーポン」への導線カードを追加
- `Account-Coupons` エンドポイントで、顧客に有効なクーポン付きプロモーションを一覧表示
- カートがある場合は試験適用（適用→ロールバック）で「今すぐ使える／使えない／利用済み」を判定

---

## なぜカスタマイズが必要か

B2C Commerce には「顧客が使えるクーポンをマイページで一覧する」標準機能がありません。
候補の取得と利用可否の判定を、以下の方針で組み合わせて実現します。

| 層 | 目的 | 使う API |
|---|---|---|
| ① 候補の取得 | 顧客に有効なクーポン付きプロモを集める | `PromotionMgr.getActiveCustomerPromotions(true)` |
| ② 利用可否の判定 | そのカートで実際に使えるか | `basket.createCouponLineItem(code, true)` + `Transaction.rollback()` |
| ③ 利用済みの判定 | 使えない理由の切り分け | ②の `errorCode === 'COUPON_CODE_ALREADY_REDEEMED'` |

### 設計上の要点（ハマりどころ）

- **`getActiveCustomerPromotions(true)` の引数 `true`（`ignoreCouponCondition`）は必須。**
  省略すると「そのクーポンがセッションバスケットに入っている」場合しかクーポン付きプロモが返らず、
  カートが空のマイページでは一覧が常に空になります。

- **`getNextCouponCode()` は型によって挙動が違う。**
  `dw.campaign.Coupon` でコードを読むメソッドは `getNextCouponCode()`（プロパティ `nextCouponCode`）のみで、`getCouponCode()` は存在しません。
  - `SINGLE_CODE` … 常に同一の固定コードを返すだけで消費しない（要 `Transaction`）。本カートリッジはこの型のときだけ実コードを表示します。
  - `MULTIPLE_CODES` / `SYSTEM_CODES` … 呼ぶたびに未発行コードを1つ**発行（消費）＋DBロック**。一覧・判定のループで呼ぶと本番障害につながるため**絶対に呼びません**。一覧では実コードを出さず「カートに入れて取得する」導線にします。

- **`getDiscounts()` では未適用クーポンの可否は判定できない。**
  `getDiscounts()` は「すでに適用済み／適用可能な割引」しか返しません。
  未適用クーポンが使えるかは ②の試験適用＋ロールバックで判定します（SFRA 標準 `Cart.js` と同型）。

---

## ディレクトリ構成

```
cartridges/plugin_customer_coupons/
└── cartridge/
    ├── controllers/
    │   └── Account.js                     # server.extend で Account-Coupons を追加
    ├── models/
    │   └── customerCoupons.js             # 表示用モデル（usable/needsBasket/redeemed 等に分類）
    ├── scripts/helpers/
    │   └── couponHelpers.js               # 中核。候補取得・試験適用・分類
    ├── templates/
    │   ├── default/account/
    │   │   ├── coupons.isml                # 一覧ページ
    │   │   ├── coupons/couponCard.isml     # 1件のカード
    │   │   ├── couponsCard.isml            # ダッシュボードの導線カード
    │   │   └── dashboardProfileCards.isml  # 標準の上書き（導線カードを追加）
    │   └── resources/
    │       ├── coupons.properties          # 英語（default）
    │       └── coupons_ja_JP.properties    # 日本語
    └── plugin_customer_coupons.properties
```

---

## インストール

1. カートリッジをリポジトリに取り込む（サブモジュール、コピー、またはビルド時取得）。
2. **カートリッジパス**を設定する。`app_storefront_base` より **前**に置きます。

   ```
   plugin_customer_coupons:app_storefront_base
   ```

   `module.superModule`（Account コントローラ拡張）と `dashboardProfileCards.isml` の上書きが
   base より優先で解決される必要があるためです。

3. サイトに反映後、マイアカウント（`Account-Show`）右カラムに「利用可能なクーポン」カードが表示されます。
   カード内リンク、または `Account-Coupons` へ直接アクセスすると一覧が表示されます。

### 前提・互換性

- SFRA（`app_storefront_base`）に依存します。`dashboardProfileCards.isml` は
  **導入先インスタンスの base のバージョンに合わせて** include 構成を調整してください
  （このカートリッジの上書きは base のカードを差し替えるため、base に存在しないテンプレートを include するとランタイムエラーになります）。
- Rhino エンジン互換のため `Object.assign` 等は使用していません。

---

## エンドポイント

| ルート | メソッド | ミドルウェア | 説明 |
|---|---|---|---|
| `Account-Coupons` | GET | `https`, `validateLoggedIn`, `consent` | ログイン済み顧客に利用可能クーポン一覧を表示 |

---

## ライセンス

MIT License. [LICENSE](./LICENSE) を参照。
