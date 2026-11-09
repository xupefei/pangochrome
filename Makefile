VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
GO_BUILD = CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$(VERSION)"

.PHONY: all helper helper-all extension install-helper uninstall-helper test test-helper test-olm test-extension clean

all: helper extension

helper:
	cd host && $(GO_BUILD) -o ../dist/pangochrome-helper .

helper-all:
	cd host && GOOS=linux  GOARCH=amd64 $(GO_BUILD) -o ../dist/pangochrome-helper-linux-amd64 .
	cd host && GOOS=linux  GOARCH=arm64 $(GO_BUILD) -o ../dist/pangochrome-helper-linux-arm64 .
	cd host && GOOS=darwin GOARCH=amd64 $(GO_BUILD) -o ../dist/pangochrome-helper-darwin-amd64 .
	cd host && GOOS=darwin GOARCH=arm64 $(GO_BUILD) -o ../dist/pangochrome-helper-darwin-arm64 .

extension:
	cd extension && npm ci && npm run build

# Registers dist/pangochrome-helper with the installed Chromium browsers.
install-helper: helper
	./dist/pangochrome-helper install

uninstall-helper:
	./dist/pangochrome-helper uninstall

test: test-helper test-olm test-extension

test-helper:
	cd host && go vet ./... && go test ./...

# Upstream olm tests for the packages the netstack patch touches.
test-olm:
	cd host/third_party/olm && go test ./olm/... ./peers/... ./dns/...

test-extension:
	cd extension && npm test && npm run typecheck

clean:
	rm -rf dist extension/dist
