.PHONY: all build run dev test fmt clean

all: build

# Build both frontend and backend.
build:
	cd frontend && npm run build
	$(MAKE) -C backend build

# Backend only.
run:
	$(MAKE) -C backend run

# Frontend dev server.
dev:
	cd frontend && npm run dev

test:
	$(MAKE) -C backend test

fmt:
	$(MAKE) -C backend fmt

clean:
	rm -rf backend/bin frontend/dist frontend/node_modules
