VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
GO_BUILD = CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$(VERSION)"
EXTENSION_ZIP = dist/pangochrome-extension-$(VERSION).zip

.PHONY: all prepare patches helper helper-all extension extension-zip release install-helper uninstall-helper test test-helper test-upstream test-extension test-install clean

all: helper extension

# Builds host/third_party from the pinned upstream modules and patches/.
prepare:
	bash scripts/upstream.sh prepare

# Writes edits made in host/third_party back to patches/.
patches:
	bash scripts/upstream.sh diff

helper: prepare
	cd host && $(GO_BUILD) -o ../dist/pangochrome-helper .

helper-all: prepare
	cd host && GOOS=linux  GOARCH=amd64 $(GO_BUILD) -o ../dist/pangochrome-helper-linux-amd64 .
	cd host && GOOS=linux  GOARCH=arm64 $(GO_BUILD) -o ../dist/pangochrome-helper-linux-arm64 .
	cd host && GOOS=darwin GOARCH=amd64 $(GO_BUILD) -o ../dist/pangochrome-helper-darwin-amd64 .
	cd host && GOOS=darwin GOARCH=arm64 $(GO_BUILD) -o ../dist/pangochrome-helper-darwin-arm64 .

extension:
	cd extension && npm ci && npm run build

# The zip to upload to the Chrome Web Store.
extension-zip: extension
	bash scripts/package-extension.sh $(EXTENSION_ZIP)

# The files of a GitHub release, in dist/.
release: helper-all extension-zip
	cp scripts/install.sh dist/install.sh
	cd dist && shasum -a 256 pangochrome-helper-linux-amd64 pangochrome-helper-linux-arm64 \
		pangochrome-helper-darwin-amd64 pangochrome-helper-darwin-arm64 \
		$(notdir $(EXTENSION_ZIP)) install.sh > SHA256SUMS.txt

# Registers dist/pangochrome-helper with the installed Chromium browsers.
install-helper: helper
	./dist/pangochrome-helper install

uninstall-helper:
	./dist/pangochrome-helper uninstall

test: test-helper test-upstream test-extension test-install

test-helper: prepare
	cd host && go vet ./... && go test ./...

# Upstream tests of the packages that the patches touch.
test-upstream: prepare
	cd host/third_party/olm && go test ./api/... ./dns/... ./olm/... ./peers/...
	cd host/third_party/newt && go test ./holepunch/... ./network/...

test-extension:
	cd extension && npm test && npm run typecheck

test-install: prepare
	bash scripts/install_test.sh

clean:
	rm -rf dist extension/dist
