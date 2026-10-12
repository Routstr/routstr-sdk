/* eslint indent: 0 */
let TLS_ADDITIONAL_ROOT_CA_LIST;
let TLS_INTERMEDIATE_CA_CACHE;
if (typeof globalThis === 'object' && globalThis) {
    TLS_ADDITIONAL_ROOT_CA_LIST = (globalThis.TLS_ADDITIONAL_ROOT_CA_LIST ||= []);
    TLS_INTERMEDIATE_CA_CACHE = (globalThis.TLS_INTERMEDIATE_CA_CACHE ||= {});
}
else if (typeof window === 'object' && window) {
    TLS_ADDITIONAL_ROOT_CA_LIST = (window.TLS_ADDITIONAL_ROOT_CA_LIST ||= []);
    TLS_INTERMEDIATE_CA_CACHE = (window.TLS_INTERMEDIATE_CA_CACHE ||= {});
}
else {
    TLS_ADDITIONAL_ROOT_CA_LIST = [];
    TLS_INTERMEDIATE_CA_CACHE = {};
}
// FORK PATCH (TLS-13): upstream added four intermediate CA certificates here
// (issued under roots that are in the bundled list) as extra trust anchors.
// They were removed: the client trusts exactly the bundled Mozilla roots, the
// same set as the node (see mozilla-root-cas.js). A server must send its
// intermediates, as every public TLS server does.
