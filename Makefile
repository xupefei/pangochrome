VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
GO_BUILD = CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$(VERSION)"
PLATFORMS = linux-amd64 linux-arm64 darwin-amd64 darwin-arm64
HELPERS = $(addprefix dist/pangochrome-helper-,$(PLATFORMS))
EXTENSION_ZIP = dist/pangochrome-extension-$(VERSION).zip
NODE_MODULES = extension/node_modules/.package-lock.json

.PHONY: all prepare patches helper helper-all extension extension-zip release install-helper uninstall-helper \
	test test-helper test-upstream test-extension test-scripts test-netns clean

all: helper extension

prepare:
	bash scripts/upstream.sh prepare

# Writes edits made in host/third_party back to patches/.
patches:
	bash scripts/upstream.sh diff

helper: prepare
	cd host && $(GO_BUILD) -o ../dist/pangochrome-helper .

helper-all: prepare
	for p in $(PLATFORMS); do \
		(cd host && GOOS=$${p%-*} GOARCH=$${p#*-} $(GO_BUILD) -o ../dist/pangochrome-helper-$$p .) || exit 1; \
	done

$(NODE_MODULES): extension/package-lock.json
	cd extension && npm ci

extension: $(NODE_MODULES)
	cd extension && npm run build

extension-zip: extension
	bash scripts/package-extension.sh $(EXTENSION_ZIP)

# The files of a GitHub release, in dist/. install.sh gets the release version.
release: helper-all extension-zip
	sed 's/^release_version=$$/release_version=$(VERSION)/' scripts/install.sh > dist/install.sh
	grep -q '^release_version=$(VERSION)$$' dist/install.sh
	cd dist && shasum -a 256 $(notdir $(HELPERS) $(EXTENSION_ZIP)) install.sh > SHA256SUMS.txt

# Registers dist/pangochrome-helper with the installed Chromium browsers.
install-helper: helper
	./dist/pangochrome-helper install

uninstall-helper:
	./dist/pangochrome-helper uninstall

test: test-helper test-upstream test-extension test-scripts

test-helper: prepare
	cd host && go vet ./... && go test ./...

# Upstream tests of the packages that the patches touch.
test-upstream: prepare
	cd host/third_party/olm && go test ./api/... ./dns/... ./olm/... ./peers/...
	cd host/third_party/newt && go test ./holepunch/... ./network/...

test-extension: $(NODE_MODULES)
	cd extension && npm test && npm run typecheck

test-scripts: prepare
	bash scripts/upstream_test.sh
	bash scripts/install_test.sh

# Linux only: checks in a network namespace that netstack mode leaves host
# routes and addresses alone.
test-netns: prepare
	cd host/third_party/newt && NETNS_TEST=1 unshare -rn go test ./network -run TestNativeConfigDisabledNetns -v

clean:
	rm -rf dist extension/dist
