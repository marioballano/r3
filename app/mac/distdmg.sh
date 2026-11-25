#!/bin/sh
set -eu

app=$1
output=$2
requested_identity=$3
notary_profile=$4

identities=$(security find-identity -v -p codesigning)
if ! identity=$(printf '%s\n' "$identities" | awk -F '"' -v requested="$requested_identity" '
    $2 ~ /^Developer ID Application: / {
        split($1, fields, " ")
        fingerprint = fields[2]
        if (requested == "" || requested == "-" || requested == $2 ||
            toupper(requested) == fingerprint) {
            identity = fingerprint
            matches++
        }
    }
    END {
        if (matches != 1) {
            exit 1
        }
        print identity
    }
'); then
    printf '%s\n' 'Expected one matching Developer ID Application identity.' \
        'Install the certificate and private key, or set SIGN_IDENTITY to its full name or SHA-1.' >&2
    exit 1
fi

work_dir=$(mktemp -d "$(dirname "$output")/.r3-dist.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 1' HUP INT TERM
stage=$work_dir/stage
staged_app=$stage/r3.app
image=$work_dir/$(basename "$output")
response=$work_dir/notary.plist
errors=$work_dir/notary.err

mkdir "$stage"
ditto "$app" "$staged_app"
codesign --force --options runtime --timestamp --sign "$identity" "$staged_app"
codesign --verify --deep --strict "$staged_app"

ln -s /Applications "$stage/Applications"
hdiutil create -volname r3 -srcfolder "$stage" -format UDZO "$image"
codesign --timestamp --identifier org.radare.r3.dmg --sign "$identity" "$image"

printf 'Submitting %s for notarization using Keychain profile %s...\n' "$(basename "$output")" "$notary_profile"
submit_result=0
xcrun notarytool submit "$image" --keychain-profile "$notary_profile" --wait \
    --output-format plist > "$response" 2> "$errors" || submit_result=$?
cat "$errors" >&2
if [ "$submit_result" -ne 0 ] ||
    [ "$(/usr/libexec/PlistBuddy -c 'Print :status' "$response" 2>/dev/null || :)" != Accepted ]; then
    printf '%s\n' 'Notarization failed.' >&2
    cat "$response" >&2
    if grep -Fq 'No Keychain password item found for profile' "$errors"; then
        printf '%s\n' 'Run make notary-setup to create the default profile, or make notary-profiles to find an existing one.' >&2
    elif submission_id=$(/usr/libexec/PlistBuddy -c 'Print :id' "$response" 2>/dev/null) &&
        [ -n "$submission_id" ]; then
        xcrun notarytool log "$submission_id" --keychain-profile "$notary_profile" >&2 || :
    fi
    exit 1
fi

xcrun stapler staple "$image"
xcrun stapler validate "$image"
mv -f "$image" "$output"
printf 'Notarized disk image: %s\n' "$output"
