CC ?= cc
PKG_CONFIG ?= pkg-config
CFLAGS ?= -O2 -g
# CFLAGS += -std=c99 -Wall -Wextra -Wpedantic
CPPFLAGS += -D_GNU_SOURCE -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE $(shell $(PKG_CONFIG) --cflags r_core)
LDLIBS += $(shell $(PKG_CONFIG) --libs r_core) -lm

ENGINE = engine/math.c engine/renderer.c
SOURCES = main.c backend.c model.c layout.c palette.c scene.c terminal.c input.c $(ENGINE)
OBJECTS = $(SOURCES:%.c=build/%.o)

.PHONY: all clean check engine-check app-check
all: r3c

r3c: $(OBJECTS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(OBJECTS) $(LDLIBS)

build/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

build/test_engine: tests/test_engine.c $(ENGINE) engine/r3engine.h
	@mkdir -p build
	$(CC) $(CFLAGS) -Iengine -o $@ tests/test_engine.c $(ENGINE) -lm

build/fixture: tests/fixture.c
	@mkdir -p build
	$(CC) -O0 -g -fno-inline -o $@ $<

build/test_app: tests/test_app.c r3c.h $(filter-out build/main.o,$(OBJECTS))
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -I. -o $@ tests/test_app.c $(filter-out build/main.o,$(OBJECTS)) $(LDLIBS)

engine-check: build/test_engine
	./build/test_engine

app-check: build/test_app build/fixture
	./build/test_app build/fixture

check: r3c engine-check app-check build/fixture
	python3 tests/smoke.py

clean:
	rm -rf build r3c

-include $(OBJECTS:.o=.d)
