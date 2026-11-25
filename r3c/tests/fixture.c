#include <stdio.h>

static int decode(int value) {
	if (value > 3) { return value * 7; }
	return value + 1;
}

static int dispatch(int value) {
	return decode (value) + decode (value - 2);
}

int main(int argc, char **argv) {
	puts ("r3c native analysis fixture");
	return dispatch (argc) + (argv[0][0] == '!');
}
