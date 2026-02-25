run: install
	cd Game && node index.js

install:
	cd Game && npm install

.PHONY: run install
