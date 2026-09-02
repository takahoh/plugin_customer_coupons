'use strict';

/**
 * @namespace Account
 *
 * app_storefront_base の Account コントローラを拡張し、マイページに
 * 「利用可能クーポン一覧」を表示する Coupons エンドポイントを追加する。
 */

var server = require('server');

// 既存の Account コントローラのルートをすべて引き継ぐ。
server.extend(module.superModule);

var userLoggedIn = require('*/cartridge/scripts/middleware/userLoggedIn');
var consentTracking = require('*/cartridge/scripts/middleware/consentTracking');

/**
 * Account-Coupons : ログイン済み顧客に、利用可能なクーポン一覧を表示する。
 * @name Base/Account-Coupons
 * @function
 * @memberof Account
 * @param {middleware} - server.middleware.https
 * @param {middleware} - userLoggedIn.validateLoggedIn
 * @param {middleware} - consentTracking.consent
 * @param {category} - sensitive
 * @param {renders} - isml
 * @param {serverfunction} - get
 */
server.get(
    'Coupons',
    server.middleware.https,
    userLoggedIn.validateLoggedIn,
    consentTracking.consent,
    function (req, res, next) {
        var BasketMgr = require('dw/order/BasketMgr');
        var URLUtils = require('dw/web/URLUtils');
        var Resource = require('dw/web/Resource');
        var CustomerCoupons = require('*/cartridge/models/customerCoupons');

        // カートがあれば、それを使ってクーポンの利用可否を正確に判定する。
        // 無ければ（カート空）候補としての提示に留まる。
        var currentBasket = BasketMgr.getCurrentBasket();

        var coupons = new CustomerCoupons(currentBasket);

        var breadcrumbs = [
            {
                htmlValue: Resource.msg('global.home', 'common', null),
                url: URLUtils.home().toString()
            },
            {
                htmlValue: Resource.msg('page.title.myaccount', 'account', null),
                url: URLUtils.url('Account-Show').toString()
            }
        ];

        res.render('account/coupons', {
            coupons: coupons,
            breadcrumbs: breadcrumbs
        });

        next();
    }
);

module.exports = server.exports();
