SWIFTC ?= swiftc
NODE ?= node
NPM ?= npm
BUILD = build
APP = $(BUILD)/r3.app
BIN = $(APP)/Contents/MacOS/r3
RESOURCES = $(APP)/Contents/Resources
DMG = $(BUILD)/r3.dmg
SWIFTFLAGS ?= -O -target $(shell uname -m)-apple-macosx11.0
SIGN_IDENTITY ?= -
export CLANG_MODULE_CACHE_PATH := $(abspath $(BUILD)/module-cache)

.PHONY: all app webui wasm update-wasm run check check-ui check-remote check-pipe clean
all: $(DMG)
app: $(BIN) webui $(RESOURCES)/r3.icns
$(BIN): Main.swift App.swift Assets.swift PipeBackend.swift Info.plist
	mkdir -p $(APP)/Contents/MacOS
	$(SWIFTC) $(SWIFTFLAGS) -framework Cocoa -framework WebKit -framework CryptoKit Assets.swift PipeBackend.swift App.swift Main.swift -o $@
	cp Info.plist $(APP)/Contents/Info.plist
../../node_modules/.package-lock.json: ../../package-lock.json ../../package.json
	cd ../.. && $(NPM) ci
	touch $@
webui: ../../node_modules/.package-lock.json wasm
	cd ../.. && $(NPM) run build -- --outDir app/mac/build/webui
	mkdir -p $(RESOURCES)/webui
	rsync -a --delete $(BUILD)/webui/ $(RESOURCES)/webui/
	mkdir -p $(RESOURCES)/webui/wasm
	cp $(BUILD)/wasm/radare2.wasm $(BUILD)/wasm/release.json $(RESOURCES)/webui/wasm/
	ditto assets $(RESOURCES)/licenses
wasm:
	$(NODE) fetch-wasm.mjs
update-wasm:
	$(NODE) fetch-wasm.mjs --update
$(BUILD)/icon-generator: Icon.swift
	mkdir -p $(BUILD)
	$(SWIFTC) $(SWIFTFLAGS) -framework Cocoa Icon.swift -o $@
$(RESOURCES)/r3.icns: $(BUILD)/icon-generator
	$(BUILD)/icon-generator $(BUILD)/r3.iconset
	mkdir -p $(RESOURCES)
	iconutil -c icns $(BUILD)/r3.iconset -o $@
$(DMG): app
	codesign --force --deep --sign "$(SIGN_IDENTITY)" $(APP)
	mkdir -p $(BUILD)/dmg/r3.app
	rsync -a --delete $(APP)/ $(BUILD)/dmg/r3.app/
	codesign --verify --deep --strict $(BUILD)/dmg/r3.app
	ln -sfn /Applications $(BUILD)/dmg/Applications
	hdiutil create -ov -volname r3 -srcfolder $(BUILD)/dmg -format UDZO $@
run: app
	$(BIN) $(FILE)
check: ../../node_modules/.package-lock.json wasm
	cd ../.. && $(NPM) run typecheck
	cd ../.. && $(NODE) --import tsx scripts/backendcheck.ts
$(BUILD)/ui-test: Assets.swift PipeBackend.swift App.swift UITest.swift
	mkdir -p $(BUILD)
	$(SWIFTC) $(SWIFTFLAGS) -framework Cocoa -framework WebKit -framework CryptoKit Assets.swift PipeBackend.swift App.swift UITest.swift -o $@
$(BUILD)/shortcuts-test: Assets.swift PipeBackend.swift App.swift ShortcutsTest.swift
	mkdir -p $(BUILD)
	$(SWIFTC) $(SWIFTFLAGS) -framework Cocoa -framework WebKit -framework CryptoKit Assets.swift PipeBackend.swift App.swift ShortcutsTest.swift -o $@
check-ui: app $(BUILD)/ui-test $(BUILD)/shortcuts-test
	$(BUILD)/ui-test "$(abspath $(RESOURCES)/webui)"
	$(BUILD)/shortcuts-test
$(BUILD)/pipe-test: PipeBackend.swift PipeTest.swift
	mkdir -p $(BUILD)
	$(SWIFTC) $(SWIFTFLAGS) PipeBackend.swift PipeTest.swift -o $@
check-pipe: $(BUILD)/pipe-test
	$(BUILD)/pipe-test
check-remote: app $(BUILD)/ui-test
	cd ../.. && $(NODE) scripts/macremotecheck.mjs
clean:
	rm -rf $(BUILD)
