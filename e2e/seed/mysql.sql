CREATE TABLE IF NOT EXISTS customers (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL, marker VARCHAR(64) NOT NULL);
TRUNCATE customers;
INSERT INTO customers (name, marker) VALUES ('Ada','MY-BETA'),('Grace','MY-BETA'),('Linus','MY-BETA');
