#!/bin/sh
set -eu

tls_dir=/tls
current_pair="$tls_dir/current"
previous_pair="$tls_dir/previous"
reload_pending="$tls_dir/reload-pending"
certificate="$current_pair/origin.crt"
private_key="$current_pair/origin.key"
renewal_seconds=$((30 * 24 * 60 * 60))
renewal_check_seconds=$((24 * 60 * 60))

die() {
    echo "proxy startup failed: $*" >&2
    exit 1
}

# Shared cases in scripts/tests/test_setup.py keep this aligned with validate_docker_origin.
validate_public_origin() {
    case "${PUBLIC_ORIGIN-}" in
        https://*) ;;
        *) die 'PUBLIC_ORIGIN must be exactly https://<FQDN>, without a port, path, or trailing slash.' ;;
    esac

    PUBLIC_HOSTNAME=${PUBLIC_ORIGIN#https://}
    [ -n "$PUBLIC_HOSTNAME" ] || die 'PUBLIC_ORIGIN must include an FQDN.'
    case "$PUBLIC_HOSTNAME" in
        *[!A-Za-z0-9.-]* | *:* | *@* | *. | .* | *..*)
            die 'PUBLIC_ORIGIN must use an ASCII DNS FQDN without credentials, a port, or a trailing dot.'
            ;;
    esac
    case "$PUBLIC_HOSTNAME" in
        *.*) ;;
        *) die 'PUBLIC_ORIGIN must contain a multi-label FQDN.' ;;
    esac
    case "$PUBLIC_HOSTNAME" in
        *[!0-9.]*) ;;
        *) die 'PUBLIC_ORIGIN must not use an IP literal.' ;;
    esac
    [ "${#PUBLIC_HOSTNAME}" -le 253 ] || die 'PUBLIC_ORIGIN hostname is longer than 253 characters.'

    remaining=$PUBLIC_HOSTNAME
    while [ -n "$remaining" ]; do
        label=${remaining%%.*}
        if [ "$remaining" = "$label" ]; then
            remaining=
        else
            remaining=${remaining#*.}
        fi
        [ -n "$label" ] && [ "${#label}" -le 63 ] || die 'PUBLIC_ORIGIN contains an invalid DNS label.'
        case "$label" in
            -* | *- | *[!A-Za-z0-9-]*) die 'PUBLIC_ORIGIN contains an invalid DNS label.' ;;
        esac
    done

    PUBLIC_HOSTNAME=$(printf '%s' "$PUBLIC_HOSTNAME" | tr 'A-Z' 'a-z')
    export PUBLIC_HOSTNAME
}

verify_pair() {
    verify_certificate=$1
    verify_key=$2
    cert_public_key=$(mktemp)
    key_public_key=$(mktemp)
    valid=1

    openssl x509 -in "$verify_certificate" -noout >/dev/null 2>&1 || valid=0
    openssl pkey -in "$verify_key" -noout >/dev/null 2>&1 || valid=0
    openssl x509 -in "$verify_certificate" -pubkey -noout >"$cert_public_key" 2>/dev/null || valid=0
    openssl pkey -in "$verify_key" -pubout >"$key_public_key" 2>/dev/null || valid=0
    cmp -s "$cert_public_key" "$key_public_key" || valid=0
    # The base image floats, so use machine-checked openssl verdicts only. Parsing the
    # human-readable -text output would tie startup to wording a future OpenSSL may change.
    openssl verify -check_ss_sig -purpose sslserver -CAfile "$verify_certificate" "$verify_certificate" >/dev/null 2>&1 || valid=0
    openssl x509 -in "$verify_certificate" -noout -checkhost "$PUBLIC_HOSTNAME" >/dev/null 2>&1 || valid=0
    openssl x509 -in "$verify_certificate" -noout -checkhost localhost >/dev/null 2>&1 || valid=0
    openssl x509 -in "$verify_certificate" -noout -checkip 127.0.0.1 >/dev/null 2>&1 || valid=0
    openssl x509 -in "$verify_certificate" -noout -checkip ::1 >/dev/null 2>&1 || valid=0
    rm -f "$cert_public_key" "$key_public_key"
    [ "$valid" -eq 1 ]
}

is_generated_pair_name() {
    case "$1" in
        .pair.*) ;;
        *) return 1 ;;
    esac
    case "$1" in
        *[!A-Za-z0-9._-]*) return 1 ;;
    esac
    [ -d "$tls_dir/$1" ] && [ ! -L "$tls_dir/$1" ]
}

write_pair() {
    new_pair=$(mktemp -d "$tls_dir/.pair.XXXXXX")
    new_key="$new_pair/origin.key"
    new_certificate="$new_pair/origin.crt"
    config=$(mktemp)
    current_link=$(mktemp "$tls_dir/.current.XXXXXX")
    pending_marker=$(mktemp "$tls_dir/.reload-pending.XXXXXX")
    rm -f "$current_link"
    trap 'rm -rf "$new_pair"; rm -f "$config" "$current_link" "$pending_marker"' EXIT HUP INT TERM
    cat >"$config" <<EOF
[req]
distinguished_name = subject
x509_extensions = extensions
prompt = no

[subject]
CN = $PUBLIC_HOSTNAME

[extensions]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alternative_names

[alternative_names]
DNS.1 = $PUBLIC_HOSTNAME
DNS.2 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF
    openssl req -x509 -new -newkey rsa:2048 -sha256 -nodes -days 825 \
        -keyout "$new_key" -out "$new_certificate" -config "$config" >/dev/null 2>&1 \
        || die 'could not generate the origin TLS certificate and key.'
    verify_pair "$new_certificate" "$new_key" || die 'generated origin TLS material did not pass validation.'
    chmod 600 "$new_key"
    chmod 644 "$new_certificate"
    # mktemp creates the pair directory as 0700 root. Host-side readers (the setup wizard, the
    # smoke test, curl --cacert) must traverse it to read origin.crt; the key stays 0600.
    chmod 755 "$new_pair"

    pair_name=$(basename "$new_pair")
    ln -s "$pair_name" "$current_link" || die 'could not prepare the atomic TLS pair switch.'
    old_current=
    old_previous=
    if [ -L "$current_pair" ]; then
        old_current=$(readlink "$current_pair")
        is_generated_pair_name "$old_current" || die 'current TLS pair does not use a generated pair directory.'
    fi
    if [ -L "$previous_pair" ]; then
        previous_target=$(readlink "$previous_pair")
        if is_generated_pair_name "$previous_target"; then
            old_previous=$previous_target
        fi
    fi
    if [ -n "$old_current" ]; then
        previous_link=$(mktemp "$tls_dir/.previous.XXXXXX")
        rm -f "$previous_link"
        ln -s "$old_current" "$previous_link" || die 'could not retain the previous TLS pair.'
        mv -Tf "$previous_link" "$previous_pair" || die 'could not retain the previous TLS pair.'
    fi
    mv -f "$pending_marker" "$reload_pending" || die 'could not record the pending nginx reload.'
    trap - EXIT HUP INT TERM
    if ! mv -Tf "$current_link" "$current_pair"; then
        rm -rf "$new_pair"
        rm -f "$config" "$reload_pending"
        die 'could not atomically activate the new TLS pair.'
    fi
    rm -f "$config"
    if [ -n "$old_previous" ] && [ "$old_previous" != "$old_current" ]; then
        rm -rf "$tls_dir/$old_previous"
    fi
}

reload_is_pending() {
    if [ ! -e "$reload_pending" ] && [ ! -L "$reload_pending" ]; then
        return 1
    fi
    [ -f "$reload_pending" ] && [ ! -L "$reload_pending" ] \
        || die "found an invalid TLS reload marker in $tls_dir. Remove reload-pending and start again."
}

prepare_certificate() {
    mkdir -p "$tls_dir"
    if [ -e "$current_pair" ] && [ ! -L "$current_pair" ]; then
        die "found an invalid TLS pair location in $tls_dir. Remove current and start again."
    fi

    if [ -L "$current_pair" ]; then
        current_target=$(readlink "$current_pair")
        is_generated_pair_name "$current_target" \
            || die "current TLS pair in $tls_dir is not a generated pair directory. Remove current so the proxy regenerates the pair."
        if [ ! -f "$certificate" ] || [ ! -f "$private_key" ]; then
            die "found a partial TLS pair in $tls_dir. Restore both origin.crt and origin.key or remove the incomplete pair."
        fi
        verify_pair "$certificate" "$private_key" \
            || die "existing TLS pair in $tls_dir is invalid, mismatched, or for a different hostname. Remove the current pair so the proxy regenerates it."
        openssl x509 -in "$certificate" -noout -checkend 0 >/dev/null 2>&1 \
            || die "existing TLS certificate in $tls_dir is expired or not yet valid. Remove the current pair so the proxy regenerates it."
        chmod 600 "$private_key"
        chmod 644 "$certificate"
        chmod 755 "$tls_dir/$current_target"
        if ! openssl x509 -in "$certificate" -noout -checkend "$renewal_seconds" >/dev/null 2>&1; then
            echo 'origin TLS certificate expires within 30 days, renewing it now.' >&2
            write_pair
        fi
    else
        echo 'origin TLS certificate is absent, generating a new self-signed pair.' >&2
        write_pair
    fi
}

renew_certificate_forever() {
    while sleep "$renewal_check_seconds"; do
        if ! /usr/local/bin/proxy-entrypoint.sh --renew-certificate; then
            echo 'origin TLS renewal check failed; retrying in 24 hours.' >&2
        fi
    done
}

validate_public_origin
if [ "${1-}" = '--validate-public-origin' ]; then
    exit 0
fi
prepare_certificate
if [ "${1-}" = '--renew-certificate' ]; then
    if reload_is_pending; then
        nginx -s reload || die 'renewed the origin TLS pair but could not reload nginx.'
        rm -f "$reload_pending"
    fi
    exit 0
fi
if reload_is_pending; then
    rm -f "$reload_pending"
fi
renew_certificate_forever &
exec /docker-entrypoint.sh "$@"
