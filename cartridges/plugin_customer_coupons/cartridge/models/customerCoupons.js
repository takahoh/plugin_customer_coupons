'use strict';

var couponHelpers = require('*/cartridge/scripts/helpers/couponHelpers');

/**
 * マイページのクーポン一覧表示用モデル。
 *
 * ① 候補を取得し（couponHelpers.getCandidateCoupons）、
 * ② バスケットがあれば試験適用で使えるものを判定して分類する。
 *
 * バスケットが無い（カート空）場合は判定できないため、候補をそのまま
 * 「使える見込みのクーポン」として提示する。実際の可否はカート投入時に
 * 標準のクーポン適用処理が最終判定する。
 *
 * @param {dw.order.Basket|null} currentBasket - 現在のバスケット（無ければ null）
 * @constructor
 */
function CustomerCoupons(currentBasket) {
    var candidates = couponHelpers.getCandidateCoupons();
    var resolved = couponHelpers.resolveUsableCoupons(currentBasket, candidates);

    // バスケットが無いときは needsBasket に候補が集まる。これらは「候補」
    // として表示する（判定不能 = 使えないではない）。
    this.hasBasket = !!currentBasket;

    this.usable = resolved.usable;
    this.needsBasket = resolved.needsBasket;

    // 利用済みは表示上、明確に分けて出せるよう抽出しておく。
    this.redeemed = resolved.unusable.filter(function (c) {
        return c.redeemed;
    });

    // 利用済み以外で使えないもの（上限超過・条件未達など）。
    this.otherUnusable = resolved.unusable.filter(function (c) {
        return !c.redeemed;
    });

    // テンプレートの「クーポンが1件も無い」判定用。
    this.totalCount = this.usable.length
        + this.needsBasket.length
        + this.redeemed.length
        + this.otherUnusable.length;
    this.isEmpty = this.totalCount === 0;
}

module.exports = CustomerCoupons;
