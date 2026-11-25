#include "r3c.h"
#include <r_getopt.h>
#include <r_util/r_time.h>
#include <math.h>
#include <signal.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted, quit_requested;

static void interrupt_handler(int signal) {
	if (signal == SIGINT) { quit_requested = 1; }
	else { interrupted = 1; }
}

static void usage(void) {
	puts ("Usage: r3c [-dhjnp] [-m mode] [-A aa|aaa|none] [-s WxH] [-t seconds] [-v city|graph|cfg] [-f function] [-r fps] [binary|http://host:port/cmd]\n"
		"  -d          built-in city demo\n"
		"  -m mode     braille (default), rgb, ansi, 256, gray, ascii, mono, mono-braille\n"
		"  -T          disable procedural textures\n"
		"  -E          disable decorative visual effects\n"
		"  -o setting  textures=off, bloom=off, fog=off, links=focus, grid=off,\n"
		"              stars=off, particles=off, entropy=off, labels=focus|all|none,\n"
		"              effects=off, sidebar=100\n"
		"  -A analysis local: aaa by default; remote: none by default\n"
		"  -s WxH      render one terminal frame and exit\n"
		"  -t seconds  animation time for a snapshot (default 4)\n"
		"  -v view     city, graph or cfg\n"
		"  -f function select a function name or hexadecimal address\n"
		"  -r fps      animation rate (default 30)\n"
		"  -p          omit ANSI colours in snapshots\n"
		"  -n          disable bloom\n"
		"  -j          dump the analysed model as JSON\n"
		"  -h          show help\n\n"
		"Examples:\n  r3c /bin/ls\n  r3c http://r2host:9090/cmd\n  r3c -s 120x40 -f main ./a.out\n\n"
		"Controls: hjkl/arrows orbit, +/- zoom, Tab select, Enter CFG, c graph,\n"
		"          n/p next/previous function, H city, f fly, WASD move, m image mode,\n"
		"          i inspector, x xrefs, [/] resize sidebar, {/} inspector tabs,\n"
		"          J/K scroll 10 lines, R next r2 theme, Ctrl-R reload,\n"
		"          m/M next/previous render mode, , settings, g address, / search,\n"
		"          . reset camera, 0 reset zoom, : r2, ? help, q/Ctrl-C confirm quit.");
}

static int image_mode(const char *name) {
	const char *names[] = {"braille", "braile", "rgb", "ansi", "256", "gray", "grey", "ascii", "mono", "mono-braille", NULL};
	const char modes[] = "bbrA2ggcaB";
	for (int i = 0; names[i]; i++) { if (!strcmp (name, names[i])) { return modes[i]; } }
	return strlen (name) == 1 && strchr ("bBrA2gca", *name)? *name: 0;
}

static void dump_model(const Model *m) {
	PJ *pj = pj_new ();
	pj_o (pj);
	pj_ks (pj, "title", m->title? m->title: "");
	pj_ka (pj, "functions");
	for (size_t i = 0; i < m->count; i++) {
		const Function *f = &m->functions[i];
		pj_o (pj); pj_kn (pj, "addr", f->addr); pj_ks (pj, "name", f->name); pj_kn (pj, "size", f->size);
		pj_ki (pj, "blocks", f->nbbs); pj_ki (pj, "complexity", f->cc); pj_end (pj);
	}
	pj_end (pj);
	pj_ka (pj, "calls");
	for (size_t i = 0; i < m->call_count; i++) {
		const Call *c = &m->calls[i];
		pj_o (pj); pj_ki (pj, "from", c->from); pj_ki (pj, "to", c->to); pj_kn (pj, "site", c->site);
		pj_kb (pj, "tail", c->tail); pj_kb (pj, "reference", c->reference); pj_end (pj);
	}
	pj_end (pj);
	pj_kn (pj, "basic_blocks", m->block_count);
	pj_end (pj);
	puts (pj_string (pj));
	pj_free (pj);
}

static void cleanup(App *a) {
	free (a->inspection); free (a->roles); free (a->hops);
	terminal_free (&a->terminal);
	r3_frame_free (&a->frame);
	graph_free (&a->graph);
	model_free (&a->model);
	backend_close (&a->backend);
	r_cons_free (a->cons);
}

int main(int argc, const char **argv) {
	App app = { .selected = -1, .focus_depth = 2, .fps = 30, .bloom = .8f, .inspector = true, .running = true, .history_cursor = -1, .image_mode = 'b',
		.textures = true, .effects = true, .stars = true, .particles = true, .fog = true, .bloom_enabled = true, .labels = 1, .entropy = true };
	const char *analysis = NULL, *selection = NULL, *view_name = "city";
	int width = 0, height = 0;
	bool json = false;
	float snapshot_time = 4;
	RGetopt opt;
	r_getopt_init (&opt, argc, argv, "A:dEf:hjm:no:pr:s:Tt:v:");
	int c;
	while ((c = r_getopt_next (&opt)) != -1) {
		switch (c) {
		case 'A': analysis = opt.arg; break;
		case 'd': app.demo = true; break;
		case 'E': app.effects = false; break;
		case 'T': app.textures = false; break;
		case 'f': selection = opt.arg; break;
		case 'h': usage (); return 0;
		case 'j': json = true; break;
		case 'm':
			app.image_mode = image_mode (opt.arg);
			if (!app.image_mode) { fprintf (stderr, "Unknown image mode: %s\n", opt.arg); return 1; }
			break;
		case 'n': app.bloom_enabled = false; break;
		case 'o':
			if (!app_setting (&app, opt.arg)) { fprintf (stderr, "Invalid setting: %s\n", opt.arg); return 1; }
			break;
		case 'p': app.plain = true; break;
		case 'r': app.fps = strtof (opt.arg, NULL); break;
		case 's':
			if (sscanf (opt.arg, "%dx%d", &width, &height) != 2 || width < 20 || width > 800 || height < 8 || height > 300) {
				fprintf (stderr, "Invalid snapshot size; use 20x8 through 800x300\n"); return 1;
			}
			app.snapshot = true;
			break;
		case 't': snapshot_time = strtof (opt.arg, NULL); break;
		case 'v': view_name = opt.arg; break;
		default: usage (); return 1;
		}
	}
	if (analysis && strcmp (analysis, "aa") && strcmp (analysis, "aaa") && strcmp (analysis, "none")) {
		fprintf (stderr, "Analysis must be aa, aaa or none\n"); return 1;
	}
	if (!isfinite (app.fps) || app.fps < 1 || app.fps > 120 || !isfinite (snapshot_time) || snapshot_time < 0) {
		fprintf (stderr, "Invalid animation rate or time\n"); return 1;
	}
	if (strcmp (view_name, "city") && strcmp (view_name, "graph") && strcmp (view_name, "cfg")) {
		fprintf (stderr, "View must be city, graph or cfg\n"); return 1;
	}
	const char *target = opt.ind < argc? argv[opt.ind]: NULL;
	if ((!target && !app.demo) || opt.ind + (target? 1: 0) != argc || (app.demo && target)) {
		usage (); return 1;
	}
	if (!app.snapshot && !json && (!isatty (STDIN_FILENO) || !isatty (STDOUT_FILENO))) {
		fprintf (stderr, "Use -s WxH for redirected output, or run in a terminal\n"); return 1;
	}
	bool remote = target && (r_str_startswith (target, "http://") || r_str_startswith (target, "https://"));
	app.cons = r_cons_new ();
	app.cons->context->color_mode = COLOR_MODE_16M;
	app.cons->maxpage = 0;
	app.cons->context->pageable = false;
	R_FREE (app.cons->pager);
	r_cons_set_interactive (app.cons, false);
	if (!app.demo) {
		fprintf (stderr, "r3c: %s %s\n", remote? "connecting to": "analysing", remote? "remote r2": target);
		if (!backend_open (&app.backend, remote? NULL: target, remote? target: NULL, analysis? analysis: remote? "none": "aaa") || !model_load (&app.model, &app.backend)) {
			fprintf (stderr, "r3c: %s\n", *app.backend.error? app.backend.error: "Cannot load binary model");
			cleanup (&app); return 1;
		}
	} else if (!model_demo (&app.model)) {
		cleanup (&app); return 1;
	}
	if (json) { dump_model (&app.model); cleanup (&app); return 0; }
	app.roles = calloc (R_MAX (1, app.model.count), 1);
	app.hops = calloc (R_MAX (1, app.model.count), 1);
	if (!app.roles || !app.hops) { cleanup (&app); return 1; }
	app.selected = selection? model_find (&app.model, selection): model_find (&app.model, "main");
	if (selection && app.selected < 0) {
		fprintf (stderr, "Function not found: %s\n", selection); cleanup (&app); return 1;
	}
	if (app.selected < 0) { app.selected = model_owner (&app.model, app.model.entry); }
	if (app.selected < 0 && app.model.count) { app.selected = 0; }
	View view = !strcmp (view_name, "cfg")? VIEW_CFG: !strcmp (view_name, "graph")? VIEW_GRAPH: VIEW_CITY;
	if (!app_view (&app, view, true) && view != VIEW_CITY) { cleanup (&app); return 1; }
	app_inspect (&app);
	if (!app.snapshot) { width = r_cons_get_size (app.cons, &height); }
	if (!terminal_resize (&app, width, height)) { cleanup (&app); return 1; }
	app_home (&app);
	app.target = app.target_goal;
	app.distance = app.distance_goal;
	if (app.snapshot) {
		app.time = snapshot_time;
		scene_update (&app, 10);
		app.time = snapshot_time;
		scene_render (&app);
		bool ok = terminal_compose (&app);
		if (ok) { terminal_present (&app); }
		cleanup (&app); return ok? 0: 1;
	}
	signal (SIGINT, interrupt_handler);
	signal (SIGTERM, interrupt_handler);
	r_cons_set_interactive (app.cons, true);
	app.cons->maxpage = 0;
	r_cons_set_cup (true);
	r_cons_set_raw (app.cons, true);
	r_cons_show_cursor (app.cons, false);
	r_cons_enable_mouse (app.cons, true);
	r_cons_print (app.cons, "\x1b[2J");
	r_cons_flush (app.cons);
	ut64 previous = r_time_now_mono ();
	int result = 0;
	while (app.running && !interrupted) {
		if (quit_requested) { quit_requested = 0; app_key (&app, 3); }
		ut64 start = r_time_now_mono ();
		float dt = fminf (.1f, (start - previous) / 1000000.f);
		previous = start;
		width = r_cons_get_size (app.cons, &height);
		if (!terminal_resize (&app, width, height)) { result = 1; break; }
		scene_update (&app, dt);
		scene_render (&app);
		if (!terminal_compose (&app)) { result = 1; break; }
		terminal_present (&app);
		ut64 elapsed = r_time_now_mono () - start;
		int remaining = (int)(1000000 / app.fps) - (int)elapsed;
		int key = app_input (&app, remaining > 0? (unsigned)remaining / 1000: 0);
		if (key >= 0) { app_key (&app, key); }
		for (int i = 0; i < 32; i++) {
			key = app_input (&app, 0);
			if (key < 0) { break; }
			app_key (&app, key);
		}
	}
	r_cons_enable_mouse (app.cons, false);
	r_cons_print (app.cons, "\x1b[0m");
	r_cons_show_cursor (app.cons, true);
	r_cons_set_raw (app.cons, false);
	r_cons_flush (app.cons);
	r_cons_set_cup (false);
	cleanup (&app);
	return result;
}
