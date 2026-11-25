#include "r3c.h"
#include <r_util/r_time.h>
#include <ctype.h>
#include <errno.h>
#include <math.h>

bool app_setting(App *a, const char *setting) {
	char key[32], value[32], extra;
	if (sscanf (setting, "%31[^=]=%31s%c", key, value, &extra) != 2) { return false; }
	if (!strcmp (key, "sidebar")) {
		char *end;
		long width = strtol (value, &end, 10);
		if (*end || width < 20 || width > 800) { return false; }
		a->sidebar_width = (int)width;
		return true;
	}
	if (!strcmp (key, "labels")) {
		if (!strcmp (value, "none")) { a->labels = 0; }
		else if (!strcmp (value, "focus")) { a->labels = 1; }
		else if (!strcmp (value, "all")) { a->labels = 2; }
		else { return false; }
		return true;
	}
	if (!strcmp (key, "links")) {
		if (!strcmp (value, "focus")) { a->ambient_links = false; }
		else if (!strcmp (value, "all")) { a->ambient_links = true; }
		else { return false; }
		return true;
	}
	bool enabled = !strcmp (value, "on") || !strcmp (value, "true") || !strcmp (value, "1");
	if (!enabled && strcmp (value, "off") && strcmp (value, "false") && strcmp (value, "0")) { return false; }
	bool *field = !strcmp (key, "textures")? &a->textures: !strcmp (key, "effects")? &a->effects:
		!strcmp (key, "bloom")? &a->bloom_enabled: !strcmp (key, "fog")? &a->fog: !strcmp (key, "grid")? &a->grid:
		!strcmp (key, "stars")? &a->stars: !strcmp (key, "particles")? &a->particles: !strcmp (key, "entropy")? &a->entropy: NULL;
	if (!field) { return false; }
	*field = enabled;
	return true;
}

void app_setting_change(App *a, int direction) {
	bool *fields[] = {&a->textures, &a->bloom_enabled, &a->fog, &a->ambient_links, &a->grid, &a->stars, &a->particles, NULL, &a->effects, &a->entropy};
	if (a->settings_row == 7) { a->labels = (a->labels + direction + 3) % 3; }
	else if (a->settings_row >= 0 && a->settings_row < 10) { *fields[a->settings_row] = !*fields[a->settings_row]; }
}

static void walk_to(App *a, int next) {
	if (next < 0 || (size_t)next >= a->graph.count) { return; }
	if (a->walk_count < (int)R_ARRAY_SIZE (a->walk)) { a->walk[a->walk_count++] = a->selected_block; }
	a->selected_block = next;
	a->instruction = 0;
	a->target_goal = a->graph.blocks[next].position;
	float aspect = a->terminal.scene_width / (float)R_MAX (1, a->terminal.scene_rows * 2);
	a->distance_goal = fmaxf (35, a->graph.blocks[next].width * 1.3f / fmaxf (.08f, aspect));
}

static void flow_key(App *a, int key) {
	if (a->selected_block < 0 || (size_t)a->selected_block >= a->graph.count) { return; }
	Block *b = &a->graph.blocks[a->selected_block];
	if (key == 'h') {
		if (a->walk_count) {
			a->selected_block = a->walk[--a->walk_count];
			a->target_goal = a->graph.blocks[a->selected_block].position;
			a->instruction = 0;
		}
	} else if (key == 'j') {
		walk_to (a, graph_block (&a->graph, b->fail != UT64_MAX? b->fail: b->jump));
	} else if (key == 'l') {
		ut64 target = b->case_count? b->cases[a->branch++ % b->case_count]: b->jump;
		walk_to (a, graph_block (&a->graph, target));
	} else if (key == 'k') {
		for (size_t i = 0; i < a->graph.count; i++) {
			Block *from = &a->graph.blocks[i];
			if (from->jump == b->addr || from->fail == b->addr) { walk_to (a, (int)i); break; }
		}
	}
}

static void refresh(App *a) {
	if (a->demo) { return; }
	ut64 selected = a->selected >= 0? a->model.functions[a->selected].addr: UT64_MAX;
	Model next = {0};
	if (!model_load (&next, &a->backend)) { model_free (&next); snprintf (a->message, sizeof (a->message), "Refresh failed: %.200s", a->backend.error); return; }
	ut8 *roles = calloc (R_MAX (1, next.count), 1), *hops = calloc (R_MAX (1, next.count), 1);
	if (!roles || !hops) { free (roles); free (hops); model_free (&next); return; }
	model_free (&a->model);
	a->model = next;
	free (a->roles); free (a->hops);
	a->roles = roles; a->hops = hops;
	a->selected = model_entry (&a->model, selected);
	if (a->selected < 0 && a->model.count) { a->selected = 0; }
	a->history_count = 0; a->history_cursor = -1;
	app_view (a, VIEW_CITY, true);
	app_inspect (a);
	snprintf (a->message, sizeof (a->message), "Reloaded %zu functions", a->model.count);
}

static void submit(App *a) {
	if (a->prompt_mode == 3) {
		char *end;
		errno = 0;
		ut64 addr = strtoull (a->prompt, &end, 0);
		if (errno || !*a->prompt || *end || a->prompt[0] == '-') {
			snprintf (a->message, sizeof (a->message), "Invalid address: %.180s", a->prompt);
		} else {
			if (!a->demo) {
				char *command = r_str_newf ("s 0x%" PFMT64x, addr);
				char *result = backend_command (&a->backend, command);
				free (command);
				if (!result) {
					snprintf (a->message, sizeof (a->message), "Cannot seek: %.200s", a->backend.error);
					a->prompt_mode = 0;
					return;
				}
				free (result);
			}
			int fi = model_owner (&a->model, addr);
			if (fi >= 0) { app_select (a, fi, true); }
			a->address_mode = true; a->address = addr;
			a->inspector = true; a->inspector_tab = 0;
			app_inspect (a);
		}
	} else if (a->prompt_mode == 1) {
		int fi = model_find (&a->model, a->prompt);
		if (fi >= 0) { app_select (a, fi, true); }
		else { snprintf (a->message, sizeof (a->message), "No function matches %.180s", a->prompt); }
	} else if (!strcmp (a->prompt, "q")) {
		a->confirm_quit = true;
	} else if (!a->demo && *a->prompt) {
		if (!strcmp (a->prompt, "VV") || !strcmp (a->prompt, "agf") || !strcmp (a->prompt, "pdf")) {
			app_view (a, VIEW_CFG, true);
		} else if (!strcmp (a->prompt, "agc")) {
			app_view (a, VIEW_GRAPH, true);
		} else {
			char *command = r_str_newf ("%s @e:scr.color=3,scr.utf8=false,asm.bytes=false,scr.interactive=false", a->prompt);
			char *result = backend_command (&a->backend, command);
			free (command);
			free (a->inspection);
			a->inspection = result? result: strdup (a->backend.error);
			a->inspector = true; a->inspector_tab = 4; a->scroll = 0;
			if (a->prompt[0] == 's' && a->prompt[1] == ' ') {
				char *seek = backend_command (&a->backend, "s");
				if (seek) { app_select (a, model_owner (&a->model, strtoull (seek, NULL, 0)), true); free (seek); }
			}
		}
	}
	a->prompt_mode = 0;
	a->prompt[0] = 0;
}

void app_key(App *a, int key) {
	if (key == 3) { a->confirm_quit = true; a->settings = false; a->prompt_mode = 0; return; }
	if (key == 4) { a->running = false; return; }
	if (a->confirm_quit) {
		if (key == 'y' || key == 'Y') { a->running = false; }
		else if (key == 'n' || key == 'N' || key == 27 || key == '\r' || key == '\n' || key == 'q') { a->confirm_quit = false; }
		return;
	}
	if (a->settings) {
		if (key == 27 || key == ',' || key == 'q') { a->settings = false; }
		else if (key == 'j' || key == KEY_DOWN) { a->settings_row = (a->settings_row + 1) % 10; }
		else if (key == 'k' || key == KEY_UP) { a->settings_row = (a->settings_row + 9) % 10; }
		else if (key == 'h' || key == KEY_LEFT) { app_setting_change (a, -1); }
		else if (key == 'l' || key == KEY_RIGHT || key == ' ' || key == '\r' || key == '\n') { app_setting_change (a, 1); }
		return;
	}
	if (a->prompt_mode) {
		size_t n = strlen (a->prompt);
		if (key == 27) { a->prompt_mode = 0; a->prompt[0] = 0; }
		else if (key == '\r' || key == '\n') { submit (a); }
		else if ((key == 127 || key == 8) && n) { a->prompt[n - 1] = 0; }
		else if (key >= 32 && key < 127 && n < sizeof (a->prompt) - 1) { a->prompt[n] = (char)key; a->prompt[n + 1] = 0; }
		return;
	}
	if (key == KEY_UP) { key = 'k'; }
	if (key == KEY_DOWN) { key = 'j'; }
	if (key == KEY_LEFT) { key = 'h'; }
	if (key == KEY_RIGHT) { key = 'l'; }
	if (key == 0) { return; }
	if (strchr ("WASDEX", key) && key > 0 && key < 128) { key = tolower (key); }
	a->message[0] = 0;
	if (a->view == VIEW_CFG && strchr ("hjkl", key) && key > 0 && key < 128) { flow_key (a, key); return; }
	switch (key) {
	case 'q': a->confirm_quit = true; break;
	case 'h': a->yaw -= .12f; break;
	case 'l': a->yaw += .12f; break;
	case 'j': a->pitch = r3_clamp (a->pitch - .08f, -.3f, 1.45f); break;
	case 'k': a->pitch = r3_clamp (a->pitch + .08f, -.3f, 1.45f); break;
	case '+': case '=': a->distance_goal = fmaxf (5, a->distance_goal * .86f); break;
	case '-': a->distance_goal = fminf (15000, a->distance_goal * 1.16f); break;
	case '0': a->distance = a->distance_goal = app_default_zoom (a); break;
	case '.':
		app_home (a);
		a->target = a->target_goal;
		a->distance = a->distance_goal;
		a->tour = false;
		break;
	case '\t': case KEY_BACKTAB:
		if (a->model.count) {
			int step = key == '\t'? 1: -1;
			int next = a->selected;
			for (size_t i = 0; i < a->model.count; i++) {
				next = (next + step + (int)a->model.count) % (int)a->model.count;
				if (a->view != VIEW_GRAPH || a->roles[next]) { break; }
			}
			app_select (a, next, false);
		}
		break;
	case 'n': case 'p':
		if (a->view == VIEW_CITY && a->model.count) {
			int next = (a->selected + (key == 'n'? 1: -1) + (int)a->model.count) % (int)a->model.count;
			app_select (a, next, false);
		}
		break;
	case 'c': app_view (a, a->view == VIEW_GRAPH? VIEW_CITY: VIEW_GRAPH, true); break;
	case 'H': app_view (a, VIEW_CITY, true); break;
	case '\r': case '\n':
		if (a->view == VIEW_CFG && a->graph.count) {
			Block *b = &a->graph.blocks[a->selected_block];
			if (a->instruction >= 0 && (size_t)a->instruction < b->op_count && b->ops[a->instruction].call) {
				int fi = model_entry (&a->model, b->ops[a->instruction].jump);
				if (fi >= 0) { app_select (a, fi, true); }
			}
		} else { app_view (a, VIEW_CFG, true); }
		break;
	case 'J': case 'K':
		if (a->inspector) { app_scroll (a, key == 'J'? 10: -10); break; }
		if (a->view == VIEW_CFG && a->graph.count) {
			Block *b = &a->graph.blocks[a->selected_block];
			a->instruction += key == 'J'? 1: -1;
			if (a->instruction >= (int)b->op_count) { flow_key (a, 'j'); }
			if (a->instruction < 0) { a->instruction = 0; }
		} else { app_scroll (a, key == 'J'? 10: -10); }
		break;
	case 27:
		if (a->help) { a->help = false; }
		else if (a->view != VIEW_CITY) { app_view (a, VIEW_CITY, true); }
		else { app_home (a); }
		break;
	case '1': case '2': case '3':
		a->focus_depth = key - '0';
		app_select (a, a->selected, false);
		break;
	case 'i': a->inspector = !a->inspector; break;
	case '[': case ']':
		a->sidebar_width = R_MAX (20, (a->sidebar_width? a->sidebar_width: a->terminal.width - a->terminal.scene_width) + (key == '['? 4: -4));
		break;
	case '{': case '}':
		a->inspector_tab = (a->inspector_tab + (key == '}'? 1: 3)) % 4;
		app_inspect (a);
		break;
	case KEY_PAGEUP: app_scroll (a, -10); break;
	case KEY_PAGEDOWN: app_scroll (a, 10); break;
	case 'b': app_history (a, -1); break;
	case 'B': app_history (a, 1); break;
	case '/': a->prompt_mode = 1; a->prompt[0] = 0; break;
	case 'g': a->prompt_mode = 3; a->prompt[0] = 0; break;
	case ':': a->prompt_mode = 2; a->prompt[0] = 0; break;
	case '?': a->help = !a->help; break;
	case ',': a->settings = !a->settings; break;
	case 't': a->tour = !a->tour; break;
	case ' ': a->paused = !a->paused; break;
	case 'f':
		a->drone = !a->drone;
		a->fly_eye = a->frame.camera.eye;
		a->tour = false;
		break;
	case 'm': case 'M': {
		const char *modes = "brAc2gaB";
		const char *current = strchr (modes, a->image_mode);
		int index = current? (int)(current - modes): 0;
		a->image_mode = modes[(index + (key == 'm'? 1: 7)) % 8];
		a->terminal.repaint = true;
		snprintf (a->message, sizeof (a->message), "Image mode: %s", image_mode_name (a->image_mode));
		break;
	}
	case 'R': app_next_theme (a); break;
	case 18: refresh (a); break;
	case 'x':
		if (!a->drone) { a->inspector = true; a->inspector_tab = 2; app_inspect (a); break; }
		// Fall through to descend in flight mode.
	case 'w': case 'a': case 's': case 'd': case 'e': {
		float speed = fmaxf (1, a->distance_goal * .07f);
		R3Vec forward = r3_vec (-sinf (a->yaw), 0, -cosf (a->yaw)), right = r3_vec (cosf (a->yaw), 0, -sinf (a->yaw));
		R3Vec move = key == 'w'? forward: key == 's'? r3_scale (forward, -1): key == 'a'? r3_scale (right, -1): key == 'd'? right: r3_vec (0, key == 'e'? 1: -1, 0);
		if (a->drone) { a->fly_eye = r3_add (a->fly_eye, r3_scale (move, speed)); }
		else { a->target_goal = r3_add (a->target_goal, r3_scale (move, speed)); }
		break;
	}
	default: break;
	}
}

void app_mouse(App *a, int button, int x, int y, bool release) {
	int previous_x = a->mouse_x, previous_y = a->mouse_y;
	a->mouse_x = x; a->mouse_y = y;
	if (a->confirm_quit) { return; }
	if (a->settings && !release && !(button & 32)) {
		int top = R_MAX (2, (a->terminal.height - 15) / 2);
		int row = y - top - 2;
		if (row >= 0 && row < 10) { a->settings_row = row; app_setting_change (a, 1); }
		return;
	}
	if (release) { a->sidebar_drag = false; return; }
	if (button & 64) {
		if ((button & 3) >= 2) { a->yaw += (button & 1)? .12f: -.12f; }
		else { app_key (a, button & 1? '-': '+'); }
		return;
	}
	if (button & 32) {
		if (a->sidebar_drag) { a->sidebar_width = R_MAX (20, a->terminal.width - x); return; }
		float dx = x - previous_x, dy = y - previous_y;
		if ((button & 3) == 2) {
			float scale = a->distance_goal / R_MAX (20, a->terminal.scene_width);
			R3Vec delta = r3_add (r3_scale (a->frame.camera.right, -dx * scale), r3_scale (a->frame.camera.up, dy * scale * 2));
			if (a->drone) { a->fly_eye = r3_add (a->fly_eye, delta); }
			else { a->target_goal = r3_add (a->target_goal, delta); }
		} else {
			a->yaw -= dx * .035f;
			a->pitch = r3_clamp (a->pitch + dy * .035f, -.3f, 1.45f);
		}
		return;
	}
	if ((button & 3) == 0 && a->inspector && abs (x - a->terminal.scene_width) <= 1) { a->sidebar_drag = true; return; }
	if ((button & 3) != 0 || x < 0 || x >= a->terminal.scene_width || y < 2 || y >= a->terminal.height - 2) { return; }
	uint32_t object = 0;
	float closest = INFINITY;
	for (int sy = 0; sy < image_yscale (a); sy++) {
		for (int sx = 0; sx < image_xscale (a); sx++) {
			size_t at = (size_t)((y - 2) * image_yscale (a) + sy) * a->frame.width + x * image_xscale (a) + sx;
			if (a->frame.object[at] && a->frame.depth[at] < closest) { closest = a->frame.depth[at]; object = a->frame.object[at]; }
		}
	}
	if (!object) { return; }
	ut64 now = r_time_now_mono ();
	if (a->view == VIEW_CFG) { walk_to (a, (int)object - 1); }
	else {
		bool double_click = (int)object - 1 == a->selected && now - a->last_click < 400000;
		app_select (a, (int)object - 1, false);
		if (double_click) { app_view (a, VIEW_CFG, true); }
	}
	a->last_click = now;
}

int app_input(App *a, unsigned timeout) {
	int key = r_cons_readchar_timeout (a->cons, timeout);
	if (key != 27) { return key; }
	int next = r_cons_readchar_timeout (a->cons, 12);
	if (next < 0) { return 27; }
	if (next != '[' && next != 'O') { return next; }
	char sequence[64] = {0};
	int length = 0;
	while (length < (int)sizeof (sequence) - 1) {
		int ch = r_cons_readchar_timeout (a->cons, 12);
		if (ch < 0) { return 27; }
		sequence[length++] = (char)ch;
		if (isalpha ((unsigned char)ch) || ch == '~') { break; }
	}
	if (sequence[0] == '<') {
		int button, x, y; char end;
		if (sscanf (sequence, "<%d;%d;%d%c", &button, &x, &y, &end) == 4) { app_mouse (a, button, x - 1, y - 1, end == 'm'); }
		return 0;
	}
	switch (sequence[0]) {
	case 'A': return KEY_UP;
	case 'B': return KEY_DOWN;
	case 'C': return KEY_RIGHT;
	case 'D': return KEY_LEFT;
	case 'Z': return KEY_BACKTAB;
	case '5': return KEY_PAGEUP;
	case '6': return KEY_PAGEDOWN;
	default: return 0;
	}
}
