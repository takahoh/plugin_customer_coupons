'use strict';

/**
 * @module couponHelpers
 *
 * マイページで「顧客が使えるクーポン」を提示するためのヘルパー群。
 *
 * 設計方針（提案資料の三層に対応）:
 *   ① 候補の取得   getCandidateCoupons()
 *      PromotionMgr.getActiveCustomerPromotions(true) を使う。
 *      引数 true (= ignoreCouponCondition) が無いと、クーポンが条件の
 *      プロモーションは「そのクーポンがセッションバスケットに入っている」
 *      場合しか返らない。ログイン直後のマイページ（カート空）では一覧が
 *      空になるため、この引数は必須。
 *   ② 利用可否の判定 checkCoupon() / resolveUsableCoupons()
 *      Transaction 内で basket.createCouponLineItem(code, true) を試し、
 *      例外が出なければ「使える」。判定後に必ず Transaction.rollback() で
 *      巻き戻すため、実バスケットは汚さない（SFRA 標準 Cart.js と同型）。
 *   ③ 利用済みの判定
 *      ②の errorCode === 'COUPON_CODE_ALREADY_REDEEMED' で検出する。
 *      追加のデータ保持は不要（真の利用制限は標準の償還上限に委ねる）。
 *
 * 注意: dw.campaign.Coupon にコードを読むメソッドは getNextCouponCode()
 *   （プロパティ nextCouponCode）しか存在せず、これは名前どおり「未発行
 *   コードを1つ発行（issue）する」書き込み操作。実機で確認した挙動として
 *   SINGLE_CODE でも 1回目のみコードを返し、発行後は null になる（＝消費する）。
 *   詳細と、なぜ本番で使うべきでないかは readSingleCodeForDisplay() の
 *   docstring を参照。本モジュールでは要望に沿って rollback 方式で暫定表示する。
 */

var PromotionMgr = require('dw/campaign/PromotionMgr');
var CouponMgr = require('dw/campaign/CouponMgr');
var Coupon = require('dw/campaign/Coupon');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger');
var collections = require('*/cartridge/scripts/util/collections');

/**
 * SINGLE_CODE クーポンの「表示用コード」を読み取る。
 *
 * ⚠️ 検証用の実装。本番スケールでは使わないこと。
 *   dw.campaign.Coupon にコードを読むメソッドは getNextCouponCode()
 *   （プロパティ nextCouponCode）しか存在せず、これは名前どおり
 *   「未発行コードを1つ発行（issue）する」書き込み操作である。
 *   実機ログで確認済みの挙動:
 *     - SINGLE_CODE でも、1回目は固定コードを返し、発行後の2回目以降は null。
 *       （＝ single-code でも「発行済み」状態になり得る／消費する）
 *     - コミットすると当該コードが発行済みになり、以後 null しか返らなくなる。
 *   そのため:
 *     1) 必ず Transaction.begin()→rollback() で囲み、発行を巻き戻す。
 *     2) それでも「その1コードの行ロック」を毎リクエストで奪い合うため、
 *        人気クーポン×高トラフィックでは行ロック競合でサイトダウンに
 *        至り得る（過去に本番障害の実例あり）。
 *
 * 本番では「表示用コード」を Coupon から読むのではなく、Promotion の
 * カスタム属性等の非破壊なソースに持たせて読むべき（getNextCouponCode に
 * 依存しない）。ここでは要望に沿って rollback 方式で暫定表示する。
 *
 * @param {string} couponID - クーポン ID
 * @returns {string|null} 表示用コード。取得できなければ null
 */
function readSingleCodeForDisplay(couponID) {
    // getActiveCustomerPromotions() 由来の Coupon は PromotionPlan 上の
    // スナップショットで getNextCouponCode() が null を返すため、
    // CouponMgr.getCoupon(id) でライブの Coupon を解決してから読む。
    var liveCoupon = CouponMgr.getCoupon(couponID);
    if (!liveCoupon) {
        return null;
    }

    var code = null;
    try {
        // ★ 発行を確定させない。必ず rollback で巻き戻す。
        Transaction.begin();
        code = liveCoupon.getNextCouponCode();
    } catch (e) {
        Logger.error('couponHelpers: failed to read single code for {0}: {1}',
            couponID, e.message);
        code = null;
    } finally {
        Transaction.rollback();
    }

    return code;
}

/**
 * 顧客に有効な「クーポン付きプロモーション」を候補として取得する。
 *
 * getActiveCustomerPromotions(true) は現在の顧客の顧客グループ・ソースコード・
 * 期間・通貨で絞り込みつつ、クーポン条件は無視して有効なプロモを返す。
 * ここで得られるのはあくまで「候補」であり、実際にカートで使えるかは
 * checkCoupon() で別途判定する。
 *
 * @returns {Array<Object>} 候補クーポンの配列。各要素:
 *   {string} promotionID      プロモーション ID
 *   {string} promotionName    プロモーション名
 *   {string} calloutMsg       コールアウトメッセージ (markup、無ければ空文字)
 *   {string} details          詳細説明 (markup、無ければ空文字)
 *   {string|null} couponCode  固定コード型の実コード。都度発行型は null
 *   {string} couponType       Coupon.TYPE_* の値
 *   {boolean} requiresIssue   実コードを表示できない（発行が必要）か
 */
function getCandidateCoupons() {
    var candidates = [];

    // ★ 引数 true (ignoreCouponCondition) が必須。省略するとカートに当該
    //    クーポンが無い限りクーポン付きプロモが取得できない。
    var plan = PromotionMgr.getActiveCustomerPromotions(true);

    collections.forEach(plan.getPromotions(), function (promo) {
        // basedOnCoupons（複数）が正。basedOnCoupon（単数）は Promotion では deprecated。
        if (!promo.basedOnCoupons) {
            return; // クーポンが条件でないプロモは対象外
        }

        collections.forEach(promo.getCoupons(), function (coupon) {
            if (!coupon.enabled) {
                return;
            }

            // 実コードを表示できるのは固定コード型 (SINGLE_CODE) のみ。
            // 都度発行型 (MULTIPLE_CODES / SYSTEM_CODES) は顧客ごとに一意の
            // コードを払い出す方式で、共通の実コードが存在しないため null とし、
            // テンプレート側で「取得する」導線にする。
            var code = null;
            if (coupon.type === Coupon.TYPE_SINGLE_CODE) {
                code = readSingleCodeForDisplay(coupon.ID);
            }

            candidates.push({
                promotionID: promo.ID,
                promotionName: promo.name || promo.ID,
                calloutMsg: promo.calloutMsg ? promo.calloutMsg.markup : '',
                details: promo.details ? promo.details.markup : '',
                couponCode: code,
                couponType: coupon.type,
                requiresIssue: code === null
            });
        });
    });

    return candidates;
}

/**
 * 指定クーポンコードが、渡されたバスケットで実際に使えるかを判定する。
 *
 * Transaction 内で試験適用し、例外が出なければ使えると判断する。判定後は
 * 必ず rollback してバスケットを元に戻すため、実バスケットは変更されない。
 *
 * @param {dw.order.Basket} basket - 判定に使うバスケット
 * @param {string} code - クーポンコード
 * @returns {Object} 判定結果:
 *   {string} code           判定したコード
 *   {boolean} applicable    使えるか
 *   {boolean} redeemed      利用済みが理由か
 *   {string|null} reason    使えない場合の errorCode（使える場合 null）
 */
function checkCoupon(basket, code) {
    var result = {
        code: code,
        applicable: false,
        redeemed: false,
        reason: null
    };

    try {
        Transaction.begin();
        // 第2引数 true = 検証あり。適用不可なら例外を投げる。
        basket.createCouponLineItem(code, true);
        result.applicable = true;
    } catch (e) {
        // e.errorCode に理由が入る（例: COUPON_CODE_ALREADY_REDEEMED,
        // REDEMPTION_LIMIT_EXCEEDED, NO_ACTIVE_PROMOTION,
        // COUPON_CODE_UNKNOWN, COUPON_DISABLED）
        result.reason = e.errorCode || 'UNKNOWN';
        result.redeemed = result.reason === 'COUPON_CODE_ALREADY_REDEEMED';
    } finally {
        // 試験適用を丸ごと巻き戻す。実バスケットを汚さないための肝。
        Transaction.rollback();
    }

    return result;
}

/**
 * 候補クーポンのうち、固定コード型のものを対象に利用可否を判定する。
 * 都度発行型（実コードなし）は試験適用できないため判定対象外とする。
 *
 * @param {dw.order.Basket} basket - 判定に使うバスケット（null 可）
 * @param {Array<Object>} candidates - getCandidateCoupons() の戻り
 * @returns {Object} { usable: Array, unusable: Array, needsBasket: Array }
 *   usable      … 現在のバスケットで使える候補（判定結果をマージ）
 *   unusable    … 使えない候補（reason 付き。利用済みは redeemed=true）
 *   needsBasket … 実コードが無く判定できなかった候補（発行導線が必要）
 */
function resolveUsableCoupons(basket, candidates) {
    var usable = [];
    var unusable = [];
    var needsBasket = [];

    candidates.forEach(function (candidate) {
        if (!candidate.couponCode) {
            needsBasket.push(candidate);
            return;
        }

        // バスケットが無ければ試験適用できない。候補としてのみ提示する。
        if (!basket) {
            needsBasket.push(candidate);
            return;
        }

        var check = checkCoupon(basket, candidate.couponCode);
        var merged = {
            promotionID: candidate.promotionID,
            promotionName: candidate.promotionName,
            calloutMsg: candidate.calloutMsg,
            details: candidate.details,
            couponCode: candidate.couponCode,
            couponType: candidate.couponType,
            requiresIssue: candidate.requiresIssue,
            reason: check.reason,
            redeemed: check.redeemed
        };

        if (check.applicable) {
            usable.push(merged);
        } else {
            unusable.push(merged);
        }
    });

    return {
        usable: usable,
        unusable: unusable,
        needsBasket: needsBasket
    };
}

module.exports = {
    getCandidateCoupons: getCandidateCoupons,
    checkCoupon: checkCoupon,
    resolveUsableCoupons: resolveUsableCoupons
};
