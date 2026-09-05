CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, marker TEXT NOT NULL);
TRUNCATE customers;
INSERT INTO customers (name, marker) VALUES ('Ada','PG-ALPHA'),('Grace','PG-ALPHA'),('Linus','PG-ALPHA');
