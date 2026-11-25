#include "r3c.h"
#include <math.h>

static R3Vec node_position(const RANode *node, float cx, float cy) {
	return r3_vec ((node->x + node->w * .5f - cx) * .6f, -(node->y + node->h * .5f - cy) * 1.2f, .15f);
}

static RGraphNode *dummy_path(RGraphNode *from, RGraphNode *to, int limit, size_t *length) {
	RGraphNode **candidate;
	R_VEC_FOREACH (&from->out_nodes, candidate) {
		RGraphNode *node = *candidate;
		size_t steps = 0;
		while (node != to && steps < (size_t)limit) {
			RANode *ascii = node->data;
			if (!ascii->is_dummy || !RVecGraphNodePtr_length (&node->out_nodes)) { break; }
			node = *RVecGraphNodePtr_at (&node->out_nodes, 0);
			steps++;
		}
		if (node == to) { *length = steps; return *candidate; }
	}
	*length = 0;
	return NULL;
}

bool graph_layout(Graph *g) {
	if (!g->count) { return true; }
	RCons *cons = r_cons_new ();
	r_cons_set_interactive (cons, false);
	cons->maxpage = 0;
	RConsCanvas *canvas = r_cons_canvas_new (cons, 1, 1, 0);
	if (!canvas) { r_cons_free (cons); return false; }
	RAGraph *layout = r_agraph_new (canvas);
	RANode **nodes = calloc (g->count, sizeof (RANode *));
	if (!layout || !nodes) { r_agraph_free (layout); free (nodes); r_cons_free (cons); return false; }
	layout->need_reload_nodes = false;
	layout->is_interactive = false;
	size_t edge_capacity = 0;
	for (size_t i = 0; i < g->count; i++) {
		Block *b = &g->blocks[i];
		char title[32];
		snprintf (title, sizeof (title), "0x%" PFMT64x, b->addr);
		RStrBuf body;
		r_strbuf_init (&body);
		for (size_t j = 0; j < b->op_count && j < 10; j++) { r_strbuf_appendf (&body, "%.48s\n", b->ops[j].text); }
		nodes[i] = r_agraph_add_node (layout, title, r_strbuf_get (&body), NULL);
		r_strbuf_fini (&body);
		if (!nodes[i]) { free (nodes); r_agraph_free (layout); r_cons_free (cons); return false; }
		edge_capacity += b->case_count + 2;
	}
	for (size_t i = 0; i < g->count; i++) {
		Block *b = &g->blocks[i];
		for (size_t j = 0; j < b->case_count + 2; j++) {
			int to = graph_block (g, j == 0? b->jump: j == 1? b->fail: b->cases[j - 2]);
			if (to >= 0) { r_agraph_add_edge (layout, nodes[i], nodes[to], false); }
		}
	}
	// This computes native layout without printing or entering r2's visual mode.
	r_agraph_get_sdb (layout);
	float minx = INFINITY, miny = INFINITY, maxx = -INFINITY, maxy = -INFINITY;
	for (size_t i = 0; i < g->count; i++) {
		minx = fminf (minx, nodes[i]->x); miny = fminf (miny, nodes[i]->y);
		maxx = fmaxf (maxx, nodes[i]->x + nodes[i]->w); maxy = fmaxf (maxy, nodes[i]->y + nodes[i]->h);
	}
	float cx = (minx + maxx) * .5f, cy = (miny + maxy) * .5f;
	g->radius = 20;
	for (size_t i = 0; i < g->count; i++) {
		Block *b = &g->blocks[i];
		b->position = node_position (nodes[i], cx, cy);
		b->position.z = 0;
		b->width = nodes[i]->w * .6f;
		b->height = nodes[i]->h * 1.2f;
		b->rank = nodes[i]->layer;
		g->radius = fmaxf (g->radius, r3_length (b->position) + fmaxf (b->width, b->height) * .5f);
	}
	g->routes = calloc (R_MAX (1, edge_capacity), sizeof (GraphRoute));
	bool ok = g->routes != NULL;
	for (size_t i = 0; ok && i < g->count; i++) {
		Block *b = &g->blocks[i];
		for (size_t j = 0; j < b->case_count + 2; j++) {
			int to = graph_block (g, j == 0? b->jump: j == 1? b->fail: b->cases[j - 2]);
			if (to < 0) { continue; }
			size_t count = 0;
			RGraphNode *path = dummy_path (nodes[i]->gnode, nodes[to]->gnode, layout->graph->n_nodes, &count);
			GraphRoute *route = &g->routes[g->route_count++];
			*route = (GraphRoute){ (int)i, to, j == 0? 0: j == 1? 1: 2, NULL, 0 };
			route->points = calloc (count + 2, sizeof (R3Vec));
			if (!route->points) { ok = false; break; }
			route->points[route->count++] = r3_add (b->position, r3_vec (j == 0? -2: 2, -b->height * .5f, .15f));
			for (size_t k = 0; k < count; k++) {
				route->points[route->count++] = node_position (path->data, cx, cy);
				path = *RVecGraphNodePtr_at (&path->out_nodes, 0);
			}
			Block *dest = &g->blocks[to];
			route->points[route->count++] = r3_add (dest->position, r3_vec (0, dest->height * .5f, .15f));
		}
	}
	free (nodes);
	r_agraph_free (layout);
	r_cons_free (cons);
	return ok;
}
