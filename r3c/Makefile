CC ?= cc
PKG_CONFIG ?= pkg-config
CFLAGS ?= -O2 -g
# CFLAGS += -std=c99 -Wall -Wextra -Wpedantic
CPPFLAGS += -D_GNU_SOURCE -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE $(shell $(PKG_CONFIG) --cflags r_core)
LDLIBS += $(shell $(PKG_CONFIG) --libs r_core) -lm

SOEXT ?= $(shell r2 -H R2_LIBEXT)
ENGINE = engine/math.c engine/renderer.c
SOURCES = app.c backend.c model.c layout.c palette.c scene.c terminal.c input.c $(ENGINE)
OBJECTS = $(SOURCES:%.c=build/%.o)
PLUGIN = build/core_r3c.$(SOEXT)

.PHONY: all plugin clean check engine-check app-check

all: r3c plugin

r3c: build/main.o $(OBJECTS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS)

plugin: $(PLUGIN)

$(PLUGIN): build/plugin.o $(OBJECTS)
	$(CC) $(CFLAGS) $(LDFLAGS) -shared -o $@ $^ $(LDLIBS)

build/%.o: %.c Makefile
	@mkdir -p $(dir $@)
	$(CC) $(CPPFLAGS) $(CFLAGS) -fPIC -MMD -MP -c $< -o $@

build/test_engine: tests/test_engine.c $(ENGINE) engine/r3engine.h
	@mkdir -p build
	$(CC) $(CFLAGS) -Iengine -o $@ tests/test_engine.c $(ENGINE) -lm

build/fixture: tests/fixture.c
	@mkdir -p build
	$(CC) -O0 -g -fno-inline -o $@ $<

build/test_app: tests/test_app.c r3c.h $(OBJECTS)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -I. -o $@ tests/test_app.c $(OBJECTS) $(LDLIBS)

engine-check: build/test_engine
	./build/test_engine

app-check: build/test_app build/fixture
	./build/test_app build/fixture

check: all engine-check app-check build/fixture
	python3 tests/smoke.py $(PLUGIN)

clean:
	rm -rf build r3c

R2PM_PLUGDIR=$(shell r2pm -H R2PM_PLUGDIR)
R2PM_BINDIR=$(shell r2pm -H R2PM_BINDIR)
R2_LIBEXT=$(shell r2 -H R2_LIBEXT)

user-install:
	mkdir -p "$(R2PM_BINDIR)" "$(R2PM_PLUGDIR)"
	mkdir -p "$(R2PM_BINDIR)"
	cp -f build/core_r3c.$(R2_LIBEXT) "$(R2PM_PLUGDIR)"

user-uninstall:
	rm -f $(R2PM_BINDIR)/r3c
	rm -f $(R2PM_PLUGDIR)/core_r3c.$(R2_LIBEXT)

-include $(OBJECTS:.o=.d) build/main.d build/plugin.d
