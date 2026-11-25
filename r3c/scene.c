#include "r3c.h"
#include <ctype.h>
#include <math.h>

typedef struct {
	R3Color color;
	R3Vec base;
	float height, width, time, fog, emphasis;
	bool panel, textures, effects;
} Material;

static R3Color fog_color(R3Color color, float depth, float density) {
	float fog = 1 - expf (-depth * depth * density * density);
	return r3_color_mix (color, r3_color (.018f, .004f, .04f), fog);
}

static R3Color material_shader(const R3Fragment *frag, const void *data) {
	const Material *m = data;
	float u = frag->u * m->width, v = frag->v * m->height;
	float edge = fminf (fminf (frag->u, 1 - frag->u) * m->width, fminf (frag->v, 1 - frag->v) * m->height);
	float outline = 1 - r3_smooth (0, .18f, edge);
	float diffuse = .24f + .3f * fmaxf (0, r3_dot (frag->normal, r3_vec (.4f, .8f, .3f)));
	float scan = m->effects? expf (-powf ((v - fmodf (m->time * 5 + m->base.x, m->height + 12)) / .6f, 2)): 0;
	float glow = outline * (1.5f + m->emphasis) + scan * .7f;
	if (!m->textures) {
		glow += fabsf (frag->normal.y) > .5f? .2f: 0;
	} else if (m->panel) {
		glow += fmodf (v, 1.2f) < .22f && frag->u > .08f && frag->u < .88f? .08f: 0;
	} else if (fabsf (frag->normal.y) < .5f) {
		int x = (int)floorf (u / .65f), y = (int)floorf (v / 1.1f);
		float hash = r3_hash ((uint32_t)(x * 17 + y * 811 + (int)m->base.x * 41));
		if (u / .65f - floorf (u / .65f) > .22f && v / 1.1f - floorf (v / 1.1f) > .3f && hash > .48f) {
			glow += .65f + .35f * sinf (m->time * (.8f + hash) + hash * 60);
		}
	} else {
		glow += .5f;
	}
	R3Color color = r3_color_scale (m->color, diffuse + glow);
	return fog_color (color, frag->depth, m->fog);
}

static void quad(App *app, R3Vec a, R3Vec b, R3Vec c, R3Vec d, Material *material, uint32_t object) {
	R3Vec normal = r3_normalize (r3_cross (r3_sub (b, a), r3_sub (c, a)));
	R3Vertex va = {a, normal, 0, 0}, vb = {b, normal, 1, 0}, vc = {c, normal, 1, 1}, vd = {d, normal, 0, 1};
	r3_triangle (&app->frame, va, vb, vc, material_shader, material, object);
	r3_triangle (&app->frame, va, vc, vd, material_shader, material, object);
}

static void box(App *app, R3Vec base, float width, float height, float depth, R3Color color, float emphasis, uint32_t object) {
	float w = width * .5f, d = depth * .5f;
	R3Vec p[8] = {
		r3_add (base, r3_vec (-w, 0, -d)), r3_add (base, r3_vec (w, 0, -d)),
		r3_add (base, r3_vec (w, 0, d)), r3_add (base, r3_vec (-w, 0, d)),
		r3_add (base, r3_vec (-w, height, -d)), r3_add (base, r3_vec (w, height, -d)),
		r3_add (base, r3_vec (w, height, d)), r3_add (base, r3_vec (-w, height, d))
	};
	const int faces[5][4] = {{0, 1, 5, 4}, {1, 2, 6, 5}, {2, 3, 7, 6}, {3, 0, 4, 7}, {4, 5, 6, 7}};
	Material material = {color, base, height, width, app->time, app->fog? .7f / fmaxf (40, app->model.radius): 0, emphasis, false, app->textures, app->effects};
	for (int i = 0; i < 5; i++) {
		quad (app, p[faces[i][0]], p[faces[i][1]], p[faces[i][2]], p[faces[i][3]], &material, object);
	}
}

static R3Color role_color(const App *app, int fi) {
	if (fi == app->selected) { return scene_color (5); }
	if (app->roles && app->roles[fi] == 1) { return scene_color (1); }
	if (app->roles && app->roles[fi] == 2) { return scene_color (4); }
	if (app->roles && app->roles[fi] == 3) { return r3_color_mix (scene_color (1), scene_color (4), .5f); }
	return app->model.functions[fi].color;
}

R3Vec scene_function(const App *app, int function) {
	return app->model.functions[function].position;
}

static void update_roles(App *a) {
	size_t n = a->model.count;
	if (!a->roles || !a->hops) { return; }
	memset (a->roles, 0, n);
	memset (a->hops, 255, n);
	if (a->selected < 0 || a->selected >= (int)n) { return; }
	a->hops[a->selected] = 0;
	for (int hop = 0; hop < a->focus_depth; hop++) {
		for (size_t i = 0; i < a->model.call_count; i++) {
			Call c = a->model.calls[i];
			if (a->hops[c.from] == hop && (hop == 0 || (a->roles[c.from] & 2))) {
				a->roles[c.to] |= 2;
				a->hops[c.to] = R_MIN (a->hops[c.to], hop + 1);
			}
			if (a->hops[c.to] == hop && (hop == 0 || (a->roles[c.to] & 1))) {
				a->roles[c.from] |= 1;
				a->hops[c.from] = R_MIN (a->hops[c.from], hop + 1);
			}
		}
	}
}

static void remember(App *a) {
	if (a->selected < 0) { return; }
	History entry = {a->view, a->model.functions[a->selected].addr, UT64_MAX, a->instruction};
	if (a->view == VIEW_CFG && a->selected_block >= 0 && (size_t)a->selected_block < a->graph.count) {
		entry.block = a->graph.blocks[a->selected_block].addr;
	}
	if (a->history_count && a->history_cursor >= 0) {
		History *cur = &a->history[a->history_cursor];
		if (cur->view == entry.view && cur->function == entry.function) {
			*cur = entry;
			return;
		}
	}
	a->history_count = a->history_cursor + 1;
	if (a->history_count == R3_HISTORY) {
		memmove (a->history, a->history + 1, (R3_HISTORY - 1) * sizeof (History));
		a->history_count--;
	}
	a->history[a->history_count++] = entry;
	a->history_cursor = a->history_count - 1;
}

float app_default_zoom(const App *a) {
	float aspect = a->terminal.scene_width > 0? a->terminal.scene_width / (float)R_MAX (1, a->terminal.scene_rows * 2): 1;
	float fit = fminf (1, fmaxf (.08f, aspect));
	return (a->view == VIEW_CITY? (a->model.radius + 60) * 2.2f: a->view == VIEW_CFG? a->graph.radius * 2.2f: 180) / fit;
}

void app_home(App *a) {
	a->drone = false;
	a->target_goal = r3_vec (0, a->view == VIEW_CITY? a->model.max_height * .25f: 0, 0);
	a->yaw = a->view == VIEW_CFG? 0: .75f;
	a->pitch = a->view == VIEW_CFG? .05f: .55f;
	a->distance_goal = app_default_zoom (a);
}

void app_scroll(App *a, int lines) {
	char *plain = ascii_copy (a->inspection);
	if (!plain) { return; }
	const char *text = plain, *end = text + strlen (text);
	while (end > text && isspace ((unsigned char)end[-1])) { end--; }
	int last = 0;
	for (const char *p = text; p < end; p++) { last += *p == '\n'; }
	a->scroll = (int)R_MIN (last, R_MAX (0, (st64)a->scroll + lines));
	free (plain);
}

void app_inspect(App *a) {
	free (a->inspection);
	a->inspection = NULL;
	a->scroll = 0;
	if (a->selected < 0 && !a->address_mode) { return; }
	Function *f = a->selected >= 0? &a->model.functions[a->selected]: NULL;
	ut64 addr = a->address_mode? a->address: f->addr;
	const char *command = a->inspector_tab == 0? (a->address_mode? "pd 96": "pdf"): a->inspector_tab == 1? "pdc": a->inspector_tab == 2? "axt": "afi";
	if (a->demo) {
		a->inspection = r_str_newf ("%s\n\n0x%" PFMT64x "  %s\n\nsize     %" PFMT64u " bytes\nblocks   %d\ncomplexity %d\n\nLoad a binary to inspect real\ndisassembly, pseudo-C and xrefs.", f? f->name: "Address", addr, f? f->name: "", f? f->size: 0, f? f->nbbs: 0, f? f->cc: 0);
		return;
	}
	char *cmd = r_str_newf ("%s @ 0x%" PFMT64x " @e:scr.color=3,scr.utf8=false,asm.bytes=false,scr.interactive=false", command, addr);
	char *text = backend_command (&a->backend, cmd);
	free (cmd);
	if (text) {
		a->inspection = text;
		if (a->inspector_tab == 2) {
			cmd = r_str_newf ("axf @ 0x%" PFMT64x " @e:scr.color=3,scr.utf8=false,asm.bytes=false,scr.interactive=false", addr);
			text = backend_command (&a->backend, cmd);
			free (cmd);
			if (text) {
				char *both = r_str_newf ("CALLERS / XREFS\n%s\nCALLEES / REFS\n%s", a->inspection, text);
				free (text); free (a->inspection);
				a->inspection = both;
			}
		}
	} else {
		a->inspection = strdup (a->backend.error);
	}
}

void app_select(App *a, int function, bool fly) {
	if (function < 0 || (size_t)function >= a->model.count) { return; }
	a->address_mode = false;
	a->selected = function;
	update_roles (a);
	if (a->view == VIEW_CFG) {
		app_view (a, VIEW_CFG, true);
	} else if (fly && a->view == VIEW_CITY) {
		a->drone = false;
		Function *f = &a->model.functions[function];
		a->target_goal = r3_add (f->city, r3_vec (0, f->height * .55f, 0));
		a->distance_goal = fmaxf (24, f->height * 2.3f);
	}
	app_inspect (a);
	remember (a);
}

static bool demo_graph(App *a) {
	graph_free (&a->graph);
	a->graph.count = 7;
	a->graph.function = a->selected;
	a->graph.blocks = calloc (7, sizeof (Block));
	if (!a->graph.blocks) { a->graph.count = 0; return false; }
	const char *instructions[] = { "push rbp", "mov rbp, rsp", "cmp edi, 0x42", "jne dispatch", "call decode", "xor eax, eax", "ret" };
	for (int i = 0; i < 7; i++) {
		Block *b = &a->graph.blocks[i];
		b->addr = a->model.functions[a->selected].addr + i * 16;
		b->jump = i < 5? b->addr + (i % 2? 32: 16): UT64_MAX;
		b->fail = i < 6? b->addr + 16: UT64_MAX;
		b->op_count = 3;
		b->ops = calloc (3, sizeof (Instruction));
		if (!b->ops) { return false; }
		for (int j = 0; j < 3; j++) { b->ops[j] = (Instruction){b->addr + j * 4, UT64_MAX, UT64_MAX, strdup (instructions[(i + j) % 7]), false}; }
	}
	return graph_layout (&a->graph);
}

bool app_view(App *a, View view, bool record) {
	if (a->selected < 0 && a->model.count) { a->selected = 0; }
	if (view == VIEW_CFG) {
		if (a->selected < 0 || !(a->demo? demo_graph (a): graph_load (&a->graph, &a->backend, &a->model, a->selected))) {
			snprintf (a->message, sizeof (a->message), "No control-flow graph available");
			return false;
		}
		a->selected_block = 0;
		a->instruction = 0;
		a->walk_count = 0;
	}
	a->view = view;
	a->yaw = view == VIEW_CFG? 0: .75f;
	app_home (a);
	update_roles (a);
	if (record) { remember (a); }
	return true;
}

void app_history(App *a, int direction) {
	int next = a->history_cursor + direction;
	if (next < 0 || next >= a->history_count) { return; }
	History entry = a->history[next];
	a->history_cursor = next;
	a->address_mode = false;
	a->selected = model_entry (&a->model, entry.function);
	app_view (a, entry.view, false);
	if (entry.view == VIEW_CFG) {
		int block = graph_block (&a->graph, entry.block);
		if (block >= 0) { a->selected_block = block; a->target_goal = a->graph.blocks[block].position; }
		a->instruction = entry.instruction;
	}
	app_inspect (a);
}

void scene_update(App *a, float dt) {
	if (!a->paused) { a->time += dt; }
	if (a->tour && !a->paused) { a->yaw += dt * .09f; }
	float blend = 1 - expf (-dt * 5);
	a->target = r3_lerp (a->target, a->target_goal, blend);
	a->distance += (a->distance_goal - a->distance) * blend;
	int counts[4] = {0}, used[4] = {0};
	if (a->view == VIEW_GRAPH) {
		for (size_t i = 0; i < a->model.count; i++) {
			if ((int)i != a->selected && a->roles[i] && a->hops[i] <= a->focus_depth) { counts[a->roles[i]]++; }
		}
	}
	for (size_t i = 0; i < a->model.count; i++) {
		Function *f = &a->model.functions[i];
		R3Vec goal = f->city;
		if (a->view == VIEW_GRAPH) {
			int role = a->roles[i];
			goal = r3_vec (0, 0, 0);
			if ((int)i != a->selected && role) {
				float angle = 2 * R3_PI * used[role]++ / R_MAX (1, counts[role]) + .2f * a->hops[i];
				float radius = fmaxf (15, fminf (80, counts[role] * 2.2f)) + a->hops[i] * 5;
				goal = r3_vec (cosf (angle) * radius, (role == 1? 16: role == 2? -16: 0) * a->hops[i], sinf (angle) * radius);
			}
		}
		f->position = r3_lerp (f->position, goal, blend);
	}
	R3Vec offset = r3_vec (sinf (a->yaw) * cosf (a->pitch), sinf (a->pitch), cosf (a->yaw) * cosf (a->pitch));
	R3Vec eye = r3_add (a->target, r3_scale (offset, a->distance));
	float aspect = a->terminal.scene_width / (float)R_MAX (1, a->terminal.scene_rows * 2);
	if (a->drone) {
		R3Vec forward = r3_scale (offset, -1);
		r3_camera_look (&a->frame.camera, a->fly_eye, r3_add (a->fly_eye, forward), 55, aspect);
	} else {
		r3_camera_look (&a->frame.camera, eye, a->target, 55, aspect);
	}
}

static void sky(App *a) {
	R3Frame *f = &a->frame;
	float horizon = f->height * (.55f + a->pitch * .5f);
	for (int y = 0; y < f->height; y++) {
		float band = expf (-fabsf (y - horizon) / (f->height * .14f));
		R3Color color = r3_color (.004f + band * .045f, .002f + band * .006f, .014f + band * .07f);
		for (int x = 0; x < f->width; x++) { f->color[(size_t)y * f->width + x] = color; }
	}
	for (unsigned i = 0; a->stars && a->effects && i < 150; i++) {
		R3Vec p = r3_vec ((r3_hash (i * 11 + 3) - .5f) * 5000, 300 + r3_hash (i * 17 + 1) * 1600, (r3_hash (i * 23 + 7) - .5f) * 5000);
		r3_point (f, p, r3_color_scale (r3_color (.4f, .5f, .8f), .2f + .2f * sinf (a->time + i)), 0, true, 0);
	}
}

static void grid(App *a) {
	float radius = a->model.radius + 55;
	int step = R_MAX (7, (int)(radius / 20));
	R3Color color = r3_color (.035f, .02f, .09f);
	for (int i = -(int)radius; a->grid && i <= (int)radius; i += step) {
		r3_line (&a->frame, r3_vec (i, -.2f, -radius), r3_vec (i, -.2f, radius), color, 1, true, 0);
		r3_line (&a->frame, r3_vec (-radius, -.2f, i), r3_vec (radius, -.2f, i), color, 1, true, 0);
	}
	for (size_t i = 0; a->entropy && i < a->model.entropy_count; i++) {
		float angle = i * 2 * R3_PI / a->model.entropy_count;
		float next = (i + .6f) * 2 * R3_PI / a->model.entropy_count;
		float value = a->model.entropy[i].value;
		float height = 3 + value * fminf (24, 8 + a->model.radius * .15f);
		R3Vec p = r3_vec (cosf (angle) * radius, 0, sinf (angle) * radius);
		R3Color col = entropy_color (value);
		R3Vec top = r3_add (p, r3_vec (0, height, 0));
		r3_line (&a->frame, p, top, col, 1, false, 0);
		r3_point (&a->frame, top, col, .6f, false, 0);
		r3_line (&a->frame, p, r3_vec (cosf (next) * radius, 0, sinf (next) * radius), r3_color_scale (col, .7f), 1, false, 0);
	}
}

static void arcs(App *a) {
	size_t budget = 1600;
	for (size_t i = 0; i < a->model.call_count && budget; i++) {
		Call c = a->model.calls[i];
		bool focus = c.from == a->selected || c.to == a->selected;
		if (a->view == VIEW_GRAPH && a->hops[c.from] <= a->focus_depth && a->hops[c.to] <= a->focus_depth) { focus = true; }
		if (!focus && !a->ambient_links) { continue; }
		if (a->view == VIEW_GRAPH && (!a->roles[c.from] || !a->roles[c.to]) && !focus) { continue; }
		if (a->view == VIEW_GRAPH && (a->hops[c.from] > a->focus_depth || a->hops[c.to] > a->focus_depth)) { continue; }
		if (!focus && i % R_MAX (1, a->model.call_count / 900)) { continue; }
		budget--;
		Function *caller = &a->model.functions[c.from], *callee = &a->model.functions[c.to];
		R3Vec start = caller->position, end = callee->position;
		if (a->view == VIEW_CITY) {
			float floor = caller->max > caller->min? 1 - ((double)c.site - caller->min) / (double)(caller->max - caller->min): 1;
			start.y += caller->height * r3_clamp (floor, 0, 1);
			end.y += callee->height;
		}
		R3Vec control = r3_scale (r3_add (start, end), .5f);
		control.y = fmaxf (start.y, end.y) + 5 + r3_length (r3_sub (end, start)) * .35f;
		R3Vec prev = start;
		for (int j = 1; j <= 16; j++) {
			float t = j / 16.f;
			R3Vec p = r3_add (r3_add (r3_scale (start, (1 - t) * (1 - t)), r3_scale (control, 2 * (1 - t) * t)), r3_scale (end, t * t));
			float phase = t - a->time * .32f + r3_hash ((uint32_t)i);
			phase -= floorf (phase);
			float pulse = a->effects? expf (-powf ((phase - .88f) * 12, 2)): 0;
			R3Color col = r3_color_scale (r3_color (1, .98f, .003f), (focus? 3.5f: .025f) + pulse * (focus? 1.5f: .3f));
			r3_line (&a->frame, prev, p, col, 1, false, 0);
			prev = p;
		}
	}
}

static void cfg_scene(App *a) {
	for (size_t i = 0; i < a->graph.count; i++) {
		Block *b = &a->graph.blocks[i];
		R3Vec p = b->position;
		R3Color color = scene_color ((int)i == a->selected_block? 5: 1);
		Material material = {color, p, b->height, b->width, a->time, a->fog? .0005f: 0, (int)i == a->selected_block? 1.f: 0, true, a->textures, a->effects};
		quad (a, r3_add (p, r3_vec (-b->width / 2, -b->height / 2, 0)), r3_add (p, r3_vec (b->width / 2, -b->height / 2, 0)),
			r3_add (p, r3_vec (b->width / 2, b->height / 2, 0)), r3_add (p, r3_vec (-b->width / 2, b->height / 2, 0)), &material, (uint32_t)i + 1);
	}
	for (size_t i = 0; i < a->graph.route_count; i++) {
		GraphRoute *route = &a->graph.routes[i];
		R3Color color = scene_color (route->kind == 0? 6: route->kind == 1? 7: 5);
		for (size_t j = 1; j < route->count; j++) {
			R3Vec start = route->points[j - 1], end = route->points[j];
			if (route->count == 2 && end.y >= start.y) {
				float lane = fmaxf (a->graph.blocks[route->from].position.x + a->graph.blocks[route->from].width * .5f,
					a->graph.blocks[route->to].position.x + a->graph.blocks[route->to].width * .5f) + 5 + route->kind * 2;
				R3Vec p1 = r3_vec (lane, start.y - 2, .3f), p2 = r3_vec (lane, end.y + 2, .3f);
				r3_line (&a->frame, start, p1, color, 1, true, 0);
				r3_line (&a->frame, p1, p2, color, 1, true, 0);
				r3_line (&a->frame, p2, end, color, 1, true, 0);
			} else {
				float middle = (start.y + end.y) * .5f;
				R3Vec p1 = r3_vec (start.x, middle, .2f), p2 = r3_vec (end.x, middle, .2f);
				r3_line (&a->frame, start, p1, color, 1, true, 0);
				r3_line (&a->frame, p1, p2, color, 1, true, 0);
				r3_line (&a->frame, p2, end, color, 1, true, 0);
			}
		}
	}
}

void scene_render(App *a) {
	r3_frame_clear (&a->frame, r3_color (0, 0, 0));
	sky (a);
	if (a->view == VIEW_CFG) {
		cfg_scene (a);
	} else {
		if (a->view == VIEW_CITY) { grid (a); }
		for (size_t i = 0; i < a->model.count; i++) {
			Function *f = &a->model.functions[i];
			if (a->view == VIEW_GRAPH && (int)i != a->selected && (!a->roles[i] || a->hops[i] > a->focus_depth)) { continue; }
			R3Color color = role_color (a, (int)i);
			if (a->view == VIEW_CITY && (int)i != a->selected && a->hops[i] > a->focus_depth) { color = r3_color_scale (color, .7f); }
			float grow = a->snapshot? 1: r3_smooth (0, 1.8f, a->time - r3_length (f->city) / fmaxf (1, a->model.radius) * .6f);
			float height = a->view == VIEW_CITY? f->height * grow: (int)i == a->selected? 5: 2.8f;
			float width = a->view == VIEW_CITY? f->width: (int)i == a->selected? 5: 2.8f;
			box (a, f->position, width, fmaxf (.05f, height), width, color, (int)i == a->selected? 1: 0, (uint32_t)i + 1);
			if (f->addr == a->model.entry && a->view == VIEW_CITY) {
				r3_line (&a->frame, r3_add (f->position, r3_vec (0, f->height, 0)), r3_add (f->position, r3_vec (0, f->height + 35, 0)), r3_color (.6f, 1, .25f), 1, true, 0);
			}
		}
		arcs (a);
		for (unsigned i = 0; a->particles && a->effects && i < 100; i++) {
			float angle = r3_hash (i * 37) * 2 * R3_PI + a->time * .012f;
			float radius = r3_hash (i * 53 + 9) * a->model.radius;
			R3Vec p = r3_vec (cosf (angle) * radius, 15 + r3_hash (i * 71 + 3) * 70 + sinf (a->time + i), sinf (angle) * radius);
			r3_point (&a->frame, p, r3_color (.04f, .2f, .3f), 0, true, 0);
		}
	}
	r3_frame_finish (&a->frame, a->effects && a->bloom_enabled? a->bloom: 0, 1.4f);
}
