# r3c

A native C terminal frontend for radare2. It renders a function city, a caller/callee constellation and control-flow graphs using a software rasterizer and `r_cons_image`. Scene labels, instructions and the inspector are terminal text. No browser, JavaScript runtime, OpenGL, TermGL, Kitty graphics or Sixel is used.

## Build and run

Install radare2 headers and libraries with colored Braille support in `r_cons_image`, a C compiler, `make` and `pkg-config`. Headers and libraries must come from the same radare2 build.

```sh
make
./r3c /bin/ls
./r3c http://r2host:9090/cmd
./r3c -d
```

Local binaries are opened with the native `RCore` API and analyzed with `aaa` by default. Use `-A aa` for lighter analysis or `-A none` to keep existing state. Remote connections use HTTP **POST `/cmd`**, with the command as the request body, and leave existing analysis intact unless `-A aa` or `-A aaa` is supplied. Both a server base URL and its `/cmd` endpoint are accepted.

For a local HTTP server, for example:

```sh
r2 -e http.bind=127.0.0.1 -e http.port=9090 -c 'aaa;=h' /bin/ls
```

## Rendering

Colored Braille is the default. `-m` selects a startup mode; `m` cycles forward and `M` cycles backward while running. The current mode appears in the header.

| Mode | Output |
| --- | --- |
| `braille` | Truecolor Braille, 2 × 4 pixels per cell |
| `rgb` | Truecolor half blocks, 1 × 2 pixels per cell |
| `ansi` | All 16 ANSI colors and half blocks |
| `256` | 256 colors and half blocks |
| `gray` | Grayscale half blocks |
| `ascii` | Colored ASCII characters |
| `mono` | Monochrome ASCII scene |
| `mono-braille` | Monochrome Braille |

Braille and half blocks need a Unicode terminal font; r2 disassembly formatting deliberately uses `scr.utf8=false`. Braille uses both RGB foreground and RGB background colors from `r_cons_image`. Image modes apply to the scene; the inspector and text overlays keep RGB colors in every mode, including ANSI, grayscale and monochrome. Instruction bytes are hidden with `asm.bytes=false`. The display is interactive, while backend commands and frame output do not invoke paging prompts.

Press `R` to cycle through installed r2 themes using `ecn`. This updates the inspector, including its background for light themes; over HTTP it changes the remote r2 theme. The scene keeps its RGB data palette, and active reference lines glow yellow. The entropy scale stays blue → cyan → green → yellow → red, from low to high entropy. HDR tone mapping preserves hue, and reference lines and entropy bars avoid additive color accumulation.

Press `,` for runtime rendering settings. Startup settings use repeatable `-o name=value` arguments:

```sh
./r3c -m ascii -T -E -o labels=focus -o sidebar=70 /bin/ls
./r3c -o fog=off -o entropy=on -o links=focus /bin/ls
```

Available boolean settings are `textures`, `effects`, `bloom`, `fog`, `grid`, `stars`, `particles` and `entropy`, with `on`/`off` values. `labels` accepts `none`, `focus` or `all`; `links` accepts `focus` or `all`. Defaults show focused labels and active reference lines, with the ground grid off. `sidebar` sets its width in columns; otherwise it takes 45% of a sufficiently wide terminal. The sidebar hides on narrow terminals.

`-T` disables procedural textures, `-E` disables decorative effects, and `-n` disables bloom. These can be changed again in the settings panel.

## Controls

| Keys / mouse | Action |
| --- | --- |
| `hjkl`, arrows | Orbit; in CFG view, walk branches |
| `+`, `-`, vertical mouse wheel | Zoom |
| Horizontal mouse wheel | Rotate horizontally |
| `.`, `0` | Reset camera / reset only zoom |
| Left drag / right drag | Orbit / pan |
| Click / double-click | Select / enter CFG |
| Drag sidebar divider | Resize the inspector |
| `n`, `p` | Next / previous function in city view |
| Tab, Shift-Tab | Next / previous function |
| Enter, `c`, `H` | CFG, constellation, city overview |
| `1`, `2`, `3` | Reference neighborhood depth |
| `f`, then WASD and `e`/`x` | Flight mode, move and rise/descend |
| `i`, `x` | Toggle inspector / show incoming and outgoing references |
| `[`, `]` | Move sidebar divider left / right |
| `{`, `}` | Previous / next inspector tab |
| `J`, `K`; PgDn, PgUp | Scroll inspector by ten lines |
| `J`, `K` with inspector hidden | Step CFG instructions |
| `b`, `B` | History back / forward |
| `g` | Prompt for an address, seek and show disassembly there |
| `/`, `:` | Find a function / run an r2 command |
| `R`, Ctrl-R | Next r2 theme / reload analysis model |
| `m`, `M`, `,` | Next mode / previous mode / rendering settings |
| `t`, Space | Automatic orbit / pause animation |
| `?`, Escape | Help / cancel or leave view |
| `q`, Ctrl-C | Confirm quit; `y` accepts, `n` or Escape cancels |

Control-flow placement uses radare2's native `RAGraph` layout, including dummy waypoints for long edges. Graph text remains selectable terminal text, rather than a rasterized font.

## Snapshots and checks

```sh
./r3c -A aa -f main -v cfg -s 150x44 ./a.out
./r3c -d -m ascii -s 120x40 -p
./r3c -A aa -j /bin/ls
make check
```

`-s WxH` renders one frame and exits; `-t seconds` sets its animation time. `-p` omits ANSI colors from snapshots; `-m mono` makes the scene monochrome while retaining colored text. `-j` dumps function, basic-block and attributed call data as JSON. `-r fps` changes the interactive frame rate.

Checks cover the independent engine, native model loading, graph layout, all image modes, foreground/background color conversion, entropy colors, theme cycling, HTTP POST behavior, a real r2 HTTP server, terminal resize, mouse input and terminal restoration. Python 3 is needed for smoke tests. HTTP tests bind localhost ports.

The reusable renderer lives in [`engine/`](engine/README.md). The frontend implements the terminal navigation and analysis views; it does not reproduce browser-specific XR or audio features of the TypeScript application.
