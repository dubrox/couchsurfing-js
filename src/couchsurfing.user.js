// ==UserScript==
// @name         CouchSurfing
// @namespace    http://luca.lauretta.info/
// @version      0.1
// @description  Extend the website functionality with the apps API
// @author       dubrox
// @match        https://www.couchsurfing.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jsSHA/2.3.1/sha1.js#sha256=jzw2Wr5YCoGy7p3KfbURQK0NHirbDadS/ihnburOhlY=
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      hapi.couchsurfing.com
// ==/UserScript==

const objectToUrlSearchString = object => {
    const p = new URLSearchParams()
    Object.entries(object).forEach(([k, v]) => p.set(k, v))
    return p.toString()
}

/**
 * Client library inspired on https://github.com/nderkach/couchsurfing-python
 *
 * @param {function(object): Promise} requester Receiving a details parameter as in https://www.tampermonkey.net/documentation.php#GM_xmlhttpRequest
 * @param {string} username
 * @param {string} password
 * @returns {object}
 * @constructor
 * @TODO: move to an independent package and just @require
 */
const CouchSurfingClient = function(requester, username, password) {
    if (!(username && password)) throw Error('Missing user and/or password!')
    let _accessToken, _uid

    const CS_URL = "https://hapi.couchsurfing.com"
    const PRIVATE_KEY = "v3#!R3v44y3ZsJykkb$E@CG#XreXeGCh"
    const defaultHeaders = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "en;q=1",
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 5.0.1;"+
            " Android SDK built for x86 Build/LSX66B) Couchsurfing"+
            "/android/20141121013910661/Couchsurfing/3.0.1/ee6a1da"
    }
    const defaultListParams = {
        page: 1,
        perPage: 999
    }

    const getUrlSignature = (key, message) => {
        const shaObj = new jsSHA('SHA-1', 'TEXT')
        shaObj.setHMACKey(key, 'TEXT')
        shaObj.update(message)
        return shaObj.getHMAC('HEX')
    }

    const request = async (method, href, customHeaders, data) => {
        const headers = Object.assign({}, defaultHeaders, customHeaders)

        const request = await requester({
            url: CS_URL + href,
            method: method,
            data,
            headers
        })

        console.log('CS API', method, href, request.response, request, customHeaders)
        return request.response
    }

    const get = async (path, params = {}) => {
        if(!_accessToken) throw Error('Missing access token!')
        if(!_uid) throw Error('Missing UID!')

        const search = objectToUrlSearchString(params)
        const href = path + (search ? `?${search}` : '')

        const signature = getUrlSignature(
            `${PRIVATE_KEY}.${_uid}`,
            href
        )

        return await request('GET', href, {
            "X-CS-Url-Signature": signature,
            "X-Access-Token": _accessToken
        });
    }

    const list = (path, params = {}) => get(path, { ...defaultListParams, ...params })

    const post = async (path, payload) => {
        const jsonPayload = JSON.stringify(payload)

        const signature = getUrlSignature(
            PRIVATE_KEY,
            path + jsonPayload
        )

        return await request('POST', path, {
            "X-CS-Url-Signature": signature
        }, jsonPayload)
    }

    return {
        setAccessToken: accessToken => { _accessToken = accessToken },
        setUserId: uid => { _uid = parseInt(uid) },
        getUserId: () => _uid,
        login: async function () {
            const r = await post('/api/v3/sessions', {
                actionType: "manual_login",
                credentials: { authToken: password, email: username }
            })

            if (!("sessionUser" in r)) { throw Error('Could not fetch the user session.') }

            _uid = parseInt(r.sessionUser.id)
            _accessToken = r.sessionUser.accessToken
            return r.sessionUser
        },
        getProfile: (uid = _uid) => get(`/api/v3/users/${uid}`),
        listFriends: (options = {}, uid = _uid) => list(`/api/v3.1/users/${uid}/friendList/friends`, options),
        searchEvents: (latLng, options = {}) => list(`/api/v3.2/events/search`, { latLng, ...options }),
        /**
         * Search for visitors by place_name. Place_id is not mandatory.
         * Optionally pass filters as a dict with possible values:
         * maxAge=100, minAge=18, countries="DEU,UKR", hasReferences=1,
         * gender=male, fluentLanguages="ukr,deu", isVerified=1,
         * keyword="some-keyword"
         */
        searchVisits: (placeDescription, options = {}) => list(`/api/v3.2/visits/search`, { placeDescription, ...options }),
        test: s => list(s.replace('_uid', _uid))
    }
}

// USER SCRIPT
/**
 * Allows to use GM_xmlhttpRequest with promises.
 * @param {object} opt GM_xmlhttpRequest details: https://www.tampermonkey.net/documentation.php#GM_xmlhttpRequest
 * @returns {Promise<object>} In the form of the argument of the onload callback in https://www.tampermonkey.net/documentation.php#GM_xmlhttpRequest
 * @constructor
 * @see https://gist.github.com/denniskupec/5b294d3e4c160831e3731f5845131ebe
 */
function Request(opt = {}) {
    Object.assign(opt, {
        timeout: 2000,
        responseType: 'json'
    })

    return new Promise((resolve, reject) => {
        opt.onerror = opt.ontimeout = reject
        opt.onload = resolve

        GM_xmlhttpRequest(opt)
    })
}

/**
 * Gets the browser to auto-fill the login credentials
 * then uses them to make the requests.
 *
 * This is safer than storing the credentials with GM_setValue
 * and is more handy than re-enter the password manually
 * each time the script loads.
 *
 * @TODO: avoid the need of clicking on the page in order for the onchange to trigger
 *
 * @returns {Promise<string[]>}
 */
function getCredentialsFromAutofill() {
    const user = document.createElement('input')
    user.type = 'text'
    user.name = 'user[login]'
    const password = document.createElement('input')
    password.type = 'password'
    password.name = 'user[password]'

    return new Promise((resolve, reject) => {
        try {
            password.onchange = () => setTimeout(() => {
                resolve([user.value, password.value]);
            }, 500)
            document.body.appendChild(user)
            document.body.appendChild(password)
        } catch (e) {
            reject(e)
        }
    });
}

(async function() {
    const [user, password] = await getCredentialsFromAutofill()
    const client = new CouchSurfingClient(Request, user, password)
    await client.login()
    // const profile = await client.getProfile()
    // const friends = await client.listFriends()
    // const events = await client.searchEvents('53.4037436,-6.5222666')
    // const visits = await client.searchVisits('Dublin')

    // allows to test quickly from the browser console
    unsafeWindow.csclient = client;
})();


