#ifndef R3C_H
#define R3C_H

#include <r_core.h>
#include <r_socket.h>
#include "engine/r3engine.h"

#define R3_PI 3.14159265358979323846f
#define R3_HISTORY 128

typedef struct {
	RCore *core;
	bool owns_core;
	char *endpoint, *name;
	char error[256];
} Backend;

typedef struct {
	ut64 addr, size, min, max;
	char *name;
	int nbbs, cc, indegree, outdegree;
	bool imported, has_blocks;
	float width, height, tint;
	R3Vec city, position;
	R3Color color;
} Function;

typedef struct { ut64 start, end, prefix_end; int function; } Interval;
typedef struct { int from, to; ut64 site; bool tail, reference; } Call;
typedef struct { ut64 addr; char *text; } String;
typedef struct { int function, string; ut64 site; } StringRef;
typedef struct { char *name; ut64 addr, size; char perm[8]; } Section;
typedef struct { ut64 addr; float value; } Entropy;

typedef struct {
	Function *functions;
	size_t count;
	Interval *blocks;
	size_t block_count;
	Call *calls;
	size_t call_count;
	String *strings;
	size_t string_count;
	StringRef *string_refs;
	size_t string_ref_count;
	Section *sections;
	size_t section_count;
	Entropy *entropy;
	size_t entropy_count;
	float radius, max_height;
	ut64 entry;
	char *title, *arch;
	int bits;
} Model;

typedef struct { ut64 addr, jump, fail; char *text; bool call; } Instruction;
typedef struct {
	ut64 addr, jump, fail;
	ut64 *cases;
	size_t case_count;
	Instruction *ops;
	size_t op_count;
	R3Vec position;
	float width, height;
	int rank;
} Block;
typedef struct { int from, to, kind; R3Vec *points; size_t count; } GraphRoute;
typedef struct { Block *blocks; size_t count; int function; float radius; GraphRoute *routes; size_t route_count; } Graph;

typedef enum { VIEW_CITY, VIEW_GRAPH, VIEW_CFG } View;
typedef struct { View view; ut64 function, block; int instruction; } History;
typedef struct { uint32_t ch, foreground, background; } Cell;
enum { KEY_UP = 256, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_PAGEUP, KEY_PAGEDOWN, KEY_BACKTAB };
typedef struct {
	int width, height, scene_width, scene_rows;
	Cell *cells, *previous;
	ut8 *occupied;
	bool repaint;
} Terminal;

typedef struct {
	Backend backend;
	Model model;
	Graph graph;
	R3Frame frame;
	Terminal terminal;
	RCons *cons;
	View view;
	int selected, selected_block, instruction, focus_depth, inspector_tab, scroll;
	ut8 *roles, *hops;
	R3Vec target, target_goal, fly_eye;
	float yaw, pitch, distance, distance_goal, time, fps, bloom;
	bool drone, tour, paused, inspector, help, plain, running, snapshot, demo;
	bool textures, effects, grid, stars, particles, fog, ambient_links, bloom_enabled, settings, entropy, confirm_quit;
	int labels, settings_row, sidebar_width;
	bool sidebar_drag;
	R3Color palette[8];
	bool themed;
	uint32_t inspector_background;
	bool address_mode;
	ut64 address;
	char theme[128];
	char *inspection;
	char prompt[256], message[256];
	int prompt_mode, image_mode;
	History history[R3_HISTORY];
	int history_count, history_cursor;
	int walk[1024], walk_count;
	int mouse_x, mouse_y, branch;
	ut64 last_click;
} App;

static inline int image_xscale(const App *a) { return a->image_mode == 'b' || a->image_mode == 'B'? 2: 1; }
static inline int image_yscale(const App *a) { return a->image_mode == 'b' || a->image_mode == 'B'? 4: 2; }
static inline const RJson *json_field(const RJson *json, const char *key) { return json && json->type == R_JSON_OBJECT? r_json_get (json, key): NULL; }
static inline const char *json_string(const RJson *json, const char *key) { const RJson *v = json_field (json, key); return v && v->type == R_JSON_STRING? v->str_value: NULL; }

int r3c_run(int argc, const char **argv, RCore *core, RCons *output);
bool backend_open(Backend *backend, const char *path, const char *url, const char *analysis);
bool backend_analyze(Backend *backend, const char *analysis);
char *backend_command(Backend *backend, const char *command);
RJson *backend_json(Backend *backend, const char *command);
void backend_close(Backend *backend);
bool model_load(Model *model, Backend *backend);
bool model_demo(Model *model);
void model_free(Model *model);
int model_entry(const Model *model, ut64 addr);
int model_owner(const Model *model, ut64 addr);
int model_find(const Model *model, const char *query);
void model_layout(Model *model);
void model_palette(Model *model, const R3Color *palette);
R3Color entropy_color(float value);
R3Color app_color(const App *app, int index);
R3Color scene_color(int index);
bool app_next_theme(App *app);
bool graph_load(Graph *graph, Backend *backend, const Model *model, int function);
void graph_free(Graph *graph);
int graph_block(const Graph *graph, ut64 addr);
bool graph_layout(Graph *graph);
ut64 json_number(const RJson *json, const char *key, ut64 fallback);
char *ascii_copy(const char *text);

void app_select(App *app, int function, bool fly);
bool app_view(App *app, View view, bool remember);
void app_inspect(App *app);
void app_scroll(App *app, int lines);
void app_home(App *app);
float app_default_zoom(const App *app);
void app_history(App *app, int direction);
void scene_update(App *app, float dt);
void scene_render(App *app);
R3Vec scene_function(const App *app, int function);
bool terminal_resize(App *app, int width, int height);
const char *image_mode_name(int mode);
bool terminal_compose(App *app);
void terminal_present(App *app);
void terminal_free(Terminal *terminal);
void terminal_text(App *app, int x, int y, const char *text, R3Color color, int limit);
void terminal_label(App *app, R3Vec point, uint32_t object, const char *text, R3Color color, bool priority);
int app_input(App *app, unsigned timeout);
void app_key(App *app, int key);
void app_mouse(App *app, int button, int x, int y, bool release);
bool app_setting(App *app, const char *setting);
void app_setting_change(App *app, int direction);

#endif
