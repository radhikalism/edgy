'use strict';

const VALID_HTTP_METHOD_LIST = [
	'DELETE',
	'GET',
	'HEAD',
	'OPTIONS',
	'PATCH',
	'POST',
	'PUT',
];

// ref: https://www.w3.org/Protocols/rfc2616/rfc2616-sec10.html
const HTTP_STATUS_CODE_DESCRIPTION = {
	200: 'OK',
	201: 'Created',
	202: 'Accepted',
	203: 'Non-Authoritative Information',
	204: 'No Content',
	205: 'Reset Content',
	206: 'Partial Content',

	300: 'Multiple Choices',
	301: 'Moved Permanently',
	302: 'Found',
	303: 'See Other',
	304: 'Not Modified',
	305: 'Use Proxy',
	// 306: reserved/unused
	307: 'Temporary Redirect',

	400: 'Bad Request',
	401: 'Unauthorized',
	402: 'Payment Required',
	403: 'Forbidden',
	404: 'Not Found',
	405: 'Method Not Allowed',
	406: 'Not Acceptable',
	407: 'Proxy Authentication Required',
	408: 'Request Timeout',
	409: 'Conflict',
	410: 'Gone',
	411: 'Length Required',
	412: 'Precondition Failed',
	413: 'Request Entity Too Large',
	414: 'Request-URI Too Long',
	415: 'Unsupported Media Type',
	416: 'Requested Range Not Satisfiable',
	417: 'Expectation Failed',

	500: 'Internal Server Error',
	501: 'Not Implemented',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
	504: 'Gateway Timeout',
	505: 'HTTP Version Not Supported',
};

const VALID_SSL_PROTOCOL_LIST = [
	'SSLv3',
	'TLSv1',
	'TLSv1.1',
	'TLSv1.2',
];


class EdgeEventBase {
	// properties: config
	setDistributionDomainName(name) {
		cfEventData(this._event).config.distributionDomainName = name;
		return this;
	}

	setDistributionId(id) {
		cfEventData(this._event).config.distributionId = id;
		return this;
	}

	setRequestId(id) {
		cfEventData(this._event).config.requestId = id;
		return this;
	}

	// properties: request
	setClientIp(ipAddr) {
		cfEventData(this._event).request.clientIp = ipAddr;
		return this;
	}

	addRequestHttpHeader(key,value) {
		addEdgeEventHttpHeaderKeyValue(
			cfEventData(this._event).request.headers,
			key,value
		);

		return this;
	}

	setHttpMethod(method) {
		if (!VALID_HTTP_METHOD_LIST.includes(method)) {
			throw new Error(`unexpected HTTP method of [${method}]`);
		}

		cfEventData(this._event).request.method = method;
		return this;
	}

	setQuerystring(qs) {
		// strip any leading question mark(s) and whitespace
		qs = qs.trim().replace(/^[? ]+/,'');

		cfEventData(this._event).request.querystring = qs;
		return this;
	}

	setUri(uri) {
		// `uri` must start with a single forward slash
		uri = uri.trim().replace(/^[/ ]+/,'');

		cfEventData(this._event).request.uri = `/${uri}`;
		return this;
	}

	async execute(handler) {
		// create copy of CloudFront Lambda@Edge event and execute Lambda@Edge handler
		const event = cfEventClone(this._event);

		// execute handler and validate returned/mutated payload
		const payload = await executeHandler(handler,event);
		this._payloadVerify(payload);

		return payload;
	}
}

class EdgeEventRequestBase extends EdgeEventBase {
	constructor(eventType,hasOrigin) {
		super();
		this._event = buildEventBase(eventType,hasOrigin,false);
	}

	// properties: request
	setRequestBody(data,isTruncated = false) {
		// note: `data` will be base64 encoded for the `cf.request.body.data` property
		cfEventData(this._event).request.body = {
			action: 'read-only',
			data: Buffer.from(data || '').toString('base64'),
			encoding: 'base64',
			inputTruncated: !!isTruncated,
		};

		return this;
	}
}

class EdgeEventResponseBase extends EdgeEventBase {
	constructor(eventType,hasOrigin) {
		super();
		this._event = buildEventBase(eventType,hasOrigin,true);
	}

	// properties: response
	addResponseHttpHeader(key,value) {
		addEdgeEventHttpHeaderKeyValue(
			cfEventData(this._event).response.headers,
			key,value
		);

		return this;
	}

	setResponseHttpStatusCode(code) {
		setEdgeEventResponseHttpStatusCode(this._event,code);
		return this;
	}
}

function buildEventBase(eventType,hasOrigin,hasResponse) {
	// common payload properties
	const event = {
		Records: [{
			cf: {
				config: {
					distributionDomainName: undefined,
					distributionId: undefined,
					eventType: eventType,
					requestId: undefined,
				},
				request: {
					// note: skipping `body` property - added with call to `EdgeEventRequestBase.setRequestBody()`
					clientIp: '127.0.0.1',
					headers: {},
					method: 'GET',
					querystring: '',
					uri: '/',
				},
			}
		}]
	};

	if (hasOrigin) {
		// additional origin (`origin-request` / `origin-response`) payload properties
		cfEventData(event).request.origin = {};
	}

	if (hasResponse) {
		// additional response payload properties
		cfEventData(event).response = { headers: {} };
		setEdgeEventResponseHttpStatusCode(event,200); // default to HTTP 200
	}

	return event;
}

function setEdgeEventRequestOriginCustom(event,domainName,path) {
	cfEventData(event).request.origin = {
		custom: {
			customHeaders: {},
			domainName: domainName,
			keepaliveTimeout: 1,
			path: (path || '/'),
			port: 443,
			protocol: 'https',
			readTimeout: 4,
			sslProtocols: [],
		}
	};
}

function setEdgeEventRequestOriginKeepaliveTimeout(event,timeout) {
	verifyEdgeEventRequestOriginModeCustom(event);
	cfEventData(event).request.origin.custom.keepaliveTimeout = intOrZero(timeout);
}

function setEdgeEventRequestOriginPort(event,port) {
	verifyEdgeEventRequestOriginModeCustom(event);
	cfEventData(event).request.origin.custom.port = intOrZero(port);
}

function setEdgeEventRequestOriginHttps(event,isHttps) {
	verifyEdgeEventRequestOriginModeCustom(event);
	cfEventData(event).request.origin.custom.protocol = (!!isHttps) ? 'https' : 'http';
}

function setEdgeEventRequestOriginReadTimeout(event,timeout) {
	verifyEdgeEventRequestOriginModeCustom(event);
	cfEventData(event).request.origin.custom.readTimeout = intOrZero(timeout);
}

function setEdgeEventRequestOriginSslProtocolList(event,protocolList) {
	verifyEdgeEventRequestOriginModeCustom(event);

	if (!Array.isArray(protocolList)) {
		throw new Error('protocol list must be an array');
	}

	const resultList = [];
	for (const item of VALID_SSL_PROTOCOL_LIST) {
		if (protocolList.includes(item)) resultList.push(item);
	}

	cfEventData(event).request.origin.custom.sslProtocols = resultList;
}

function setEdgeEventRequestOriginS3(event,domainName,region,path) {
	cfEventData(event).request.origin = {
		s3: {
			authMethod: 'none',
			customHeaders: {},
			domainName: domainName,
			path: (path || '/'),
			region: (region || ''),
		}
	};
}

function setEdgeEventRequestOriginOAI(event,isOAI) {
	verifyEdgeEventRequestOriginModeS3(event);
	cfEventData(event).request.origin.s3.authMethod = (!!isOAI) ? 'origin-access-identity' : 'none';
}

// addEdgeEventRequestOriginHttpHeader() is the only origin method shared by custom/S3 modes
function addEdgeEventRequestOriginHttpHeader(event,key,value) {
	const origin = cfEventData(event).request.origin;
	if (origin.hasOwnProperty('custom')) {
		addEdgeEventHttpHeaderKeyValue(origin.custom.customHeaders,key,value);
		return;
	}

	if (origin.hasOwnProperty('s3')) {
		addEdgeEventHttpHeaderKeyValue(origin.s3.customHeaders,key,value);
		return;
	}

	throw new Error('an origin mode must be set via [setRequestOriginCustom()/setRequestOriginS3()]');
}

function verifyEdgeEventRequestOriginModeCustom(event) {
	const origin = cfEventData(event).request.origin;
	if ((origin === undefined) || !origin.hasOwnProperty('custom')) {
		throw new Error('method only valid in custom origin [setRequestOriginCustom()] mode');
	}
}

function verifyEdgeEventRequestOriginModeS3(event) {
	const origin = cfEventData(event).request.origin;
	if ((origin === undefined) || !origin.hasOwnProperty('s3')) {
		throw new Error('method only valid in S3 origin [setRequestOriginS3()] mode');
	}
}

function setEdgeEventResponseHttpStatusCode(event,httpCode) {
	const response = cfEventData(event).response;
	response.status = '' + httpCode; // as string
	response.statusDescription = HTTP_STATUS_CODE_DESCRIPTION[httpCode] || '';
}

function addEdgeEventHttpHeaderKeyValue(headerCollection,key,value) {
	// trim whitespace from key/value
	key = key.trim();
	value = value.trim();
	const keyLower = key.toLowerCase();

	// if HTTP header key doesn't exist - create
	if (!headerCollection.hasOwnProperty(keyLower)) {
		headerCollection[keyLower] = [];
	}

	// add HTTP header to collection
	headerCollection[keyLower].push({
		key: key,
		value: value,
	});
}

async function executeHandler(handler,event) {
	const argLength = handler.length;

	// execute Lambda@Edge handler based on type
	// see: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html
	if (handler.constructor.name == 'AsyncFunction') {
		if (argLength < 1 || argLength > 2) {
			throw new Error('unexpected async handler argument count - expecting either one or two arguments');
		}

		return await handler(event,{});
	}

	// callback handler
	if (argLength != 3) {
		throw new Error('unexpected callback handler argument count - expecting exactly three arguments');
	}

	return new Promise(function(resolve,reject) {
		handler(event,{},function(err,payload) {
			if (err) {
				// return error from Lambda@Edge function callback
				return reject(err);
			}

			resolve(payload);
		});
	});
}

function payloadVerifyRequest(payload) {
	// payload must be an object
	if (typeof payload != 'object') {
		throw new Error('expected payload to be of type object');
	}

	// confirm expected properties exist
	payloadPropertyExistsString(payload,'clientIp');
	payloadPropertyExistsObject(payload,'headers');
	payloadPropertyExistsString(payload,'method');
	payloadPropertyExistsString(payload,'querystring');
	payloadPropertyExistsString(payload,'uri');

	// ensure `payload.method` is a valid HTTP method
	if (!VALID_HTTP_METHOD_LIST.includes(payload.method)) {
		throw new Error(`unexpected payload HTTP [method] of [${payload.method}]`);
	}

	// ensure `payload.uri` starts with forward slash
	if (payload.uri.slice(0,1) != '/') {
		throw new Error(`payload value [uri] must begin with forward slash - got [${payload.uri}]`);
	}

	// if `payload.body` exists - validate properties within
	if (payload.hasOwnProperty('body')) {
		payloadPropertyExistsObject(payload,'body');
		const body = payload.body;

		// confirm expected `body` properties exist
		payloadPropertyExistsString(body,'action','body');
		payloadPropertyExistsString(body,'data','body');
		payloadPropertyExistsString(body,'encoding','body');
		payloadPropertyExists(body,'inputTruncated','body');

		// verify `body.action` and `body.encoding` properties have allowed values
		if (!['read-only','replace'].includes(body.action)) {
			throw new Error(`payload value [body.action] must be 'read-only' or 'replace' - got [${body.action}]`);
		}

		if (!['base64','text'].includes(body.encoding)) {
			throw new Error(`payload value [body.encoding] must be 'base64' or 'text' - got [${body.encoding}]`);
		}
	}
}

function payloadVerifyRequestOrigin(payload) {
	function isValidPath(path) {
		if (path.slice(0,1) != '/') {
			return false;
		}

		if ((path != '/') && (path.slice(-1) == '/')) {
			return false;
		}

		return true;
	}

	payloadPropertyExistsObject(payload,'origin');
	const origin = payload.origin;

	// origin must contain a property - one of `custom` or `s3`
	if (origin.hasOwnProperty('custom') && origin.hasOwnProperty('s3')) {
		throw new Error('expected payload property [origin] to contain child of [custom] or [s3] - never both');
	}

	if (!origin.hasOwnProperty('custom') && !origin.hasOwnProperty('s3')) {
		throw new Error('expected payload property [origin] to contain child of either [custom] or [s3]');
	}

	if (origin.hasOwnProperty('custom')) {
		payloadPropertyExistsObject(origin,'custom','origin');
		const custom = origin.custom;

		// confirm expected properties exist
		payloadPropertyExistsObject(custom,'customHeaders','origin.custom');
		payloadPropertyExistsString(custom,'domainName','origin.custom');
		payloadPropertyExistsNumber(custom,'keepaliveTimeout','origin.custom');
		payloadPropertyExistsString(custom,'path','origin.custom');
		payloadPropertyExistsNumber(custom,'port','origin.custom');
		payloadPropertyExistsString(custom,'protocol','origin.custom');
		payloadPropertyExistsNumber(custom,'readTimeout','origin.custom');
		payloadPropertyExists(custom,'sslProtocols','origin.custom');

		// ensure `origin.custom.domainName` is non-empty
		if (custom.domainName.trim() == '') {
			throw new Error('payload property [origin.custom.domainName] must be non-empty');
		}

		// ensure `origin.custom.keepaliveTimeout` is within bounds
		if ((custom.keepaliveTimeout < 1) || (custom.keepaliveTimeout > 60)) {
			throw new Error(`payload property [origin.custom.keepaliveTimeout] must be between 1-60 seconds - got [${custom.keepaliveTimeout}]`);
		}

		// ensure `origin.custom.path` is valid
		if (!isValidPath(custom.path)) {
			throw new Error(`payload property [origin.custom.path] must begin with, but not end with a forward slash - got [${custom.path}]`);
		}

		// ensure `origin.custom.port` is within bounds
		if (
			(custom.port != 80) &&
			(custom.port != 443) &&
			((custom.port < 1024) || (custom.port > 65535))
		) {
			throw new Error(`payload property [origin.custom.port] must be a value of 80,443 or between 1024-65535 - got [${custom.port}]`);
		}

		// verify `origin.custom.protocol` is one of 'http' or 'https'
		if (!['http','https'].includes(custom.protocol)) {
			throw new Error(`payload value [origin.custom.protocol] must be 'http' or 'https' - got [${custom.protocol}]`);
		}

		// ensure `origin.custom.readTimeout` is within bounds
		if ((custom.readTimeout < 4) || (custom.readTimeout > 60)) {
			throw new Error(`payload property [origin.custom.readTimeout] must be between 4-60 seconds - got [${custom.readTimeout}]`);
		}

		// ensure `origin.custom.sslProtocols` is an array and contains valid protocols
		if (!Array.isArray(custom.sslProtocols)) {
			throw new Error('payload property [origin.custom.sslProtocols] must be an array');
		}

		for (const item of custom.sslProtocols) {
			if (!VALID_SSL_PROTOCOL_LIST.includes(item)) {
				throw new Error(`payload property [origin.custom.sslProtocols] contains an invalid protocol - got [${item}]`);
			}
		}
	}

	if (origin.hasOwnProperty('s3')) {
		payloadPropertyExistsObject(origin,'s3','origin');
		const s3 = origin.s3;

		// confirm expected properties exist
		payloadPropertyExistsString(s3,'authMethod','origin.s3');
		payloadPropertyExistsObject(s3,'customHeaders','origin.s3');
		payloadPropertyExistsString(s3,'domainName','origin.s3');
		payloadPropertyExistsString(s3,'path','origin.s3');
		payloadPropertyExistsString(s3,'region','origin.s3');

		// verify `origin.s3.authMethod` is one of 'none' or 'origin-access-identity'
		if (!['origin-access-identity','none'].includes(s3.authMethod)) {
			throw new Error(`payload value [origin.s3.authMethod] must be 'origin-access-identity' or 'none' - got [${s3.authMethod}]`);
		}

		// ensure `origin.s3.domainName` is non-empty
		if (s3.domainName.trim() == '') {
			throw new Error('payload property [origin.s3.domainName] must be non-empty');
		}

		// ensure `origin.s3.path` is valid
		if (!isValidPath(s3.path)) {
			throw new Error(`payload property [origin.s3.path] must begin with, but not end with a forward slash - got [${s3.path}]`);
		}
	}
}

function payloadVerifyResponse(payload) {
	// payload must be an object
	if (typeof payload != 'object') {
		throw new Error('expected payload to be of type object');
	}

	// confirm expected properties exist
	payloadPropertyExistsObject(payload,'headers');
	payloadPropertyExistsString(payload,'status');
	payloadPropertyExistsString(payload,'statusDescription');

	// ensure `payload.status` is a valid/known HTTP status code
	if (!HTTP_STATUS_CODE_DESCRIPTION.hasOwnProperty(payload.status)) {
		throw new Error(`payload value [status] is an unknown HTTP status code - got [${payload.status}]`);
	}
}

function payloadPropertyExists(payload,property,prefix) {
	if (payload.hasOwnProperty(property)) {
		return;
	}

	throw new Error(`expected payload property [${payloadPropertyDisplay(prefix,property)}] not found`);
}

function payloadPropertyExistsObject(payload,property,prefix) {
	payloadPropertyExists(payload,property,prefix);
	if (typeof payload[property] == 'object') {
		return;
	}

	throw new Error(`expected payload property [${payloadPropertyDisplay(prefix,property)}] to be of type object`);
}

function payloadPropertyExistsString(payload,property,prefix) {
	payloadPropertyExists(payload,property,prefix);
	if (typeof payload[property] == 'string') {
		return;
	}

	throw new Error(`expected payload property [${payloadPropertyDisplay(prefix,property)}] to be of type string`);
}

function payloadPropertyExistsNumber(payload,property,prefix) {
	payloadPropertyExists(payload,property,prefix);
	if (typeof payload[property] == 'number') {
		return;
	}

	throw new Error(`expected payload property [${payloadPropertyDisplay(prefix,property)}] to be of type number`);
}

function payloadPropertyDisplay(prefix,property) {
	return (prefix) ? `${prefix}.${property}` : property;
}

function cfEventData(event) {
	return event.Records[0].cf;
}

// cfEventClone() performs a basic deep copy of a CloudFront Lambda@Edge event (object/array/primitive types)
function cfEventClone(event,seen = new WeakMap()) {
	// primitive type?
	if (!(event instanceof Object)) {
		return event;
	}

	// property already cloned?
	if (seen.get(event)) {
		// return prior clone - avoid circular refs
		return seen.get(event);
	}

	if (Array.isArray(event)) {
		// array type
		const clone = [];
		seen.set(event,clone);
		for (const value of event) {
			clone.push(cfEventClone(value,seen));
		}

		return clone;
	}

	// `{}` type
	const clone = {};
	seen.set(event,clone);
	for (const key of Object.keys(event)) {
		clone[key] = cfEventClone(event[key],seen);
	}

	return clone;
}

function intOrZero(value) {
	value = parseInt(value,10);
	return (isNaN(value)) ? 0 : value;
}


module.exports = {
	EdgeEventRequestBase,
	EdgeEventResponseBase,

	// functions for mutating `event.Records[0].cf.request.origin.[custom|s3]`
	setEdgeEventRequestOriginCustom,
	setEdgeEventRequestOriginKeepaliveTimeout,
	setEdgeEventRequestOriginPort,
	setEdgeEventRequestOriginHttps,
	setEdgeEventRequestOriginReadTimeout,
	setEdgeEventRequestOriginSslProtocolList,
	setEdgeEventRequestOriginS3,
	setEdgeEventRequestOriginOAI,
	addEdgeEventRequestOriginHttpHeader,

	// functions for verifying returned Lambda@Edge function payloads
	payloadVerifyRequest,
	payloadVerifyRequestOrigin,
	payloadVerifyResponse,

	// functions exported for tests
	setEdgeEventResponseHttpStatusCode,
	cfEventClone,
};
