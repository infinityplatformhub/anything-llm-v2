IF DB_ID('gamma_db') IS NULL CREATE DATABASE gamma_db;
GO
USE gamma_db;
IF OBJECT_ID('customers') IS NULL CREATE TABLE customers (id INT IDENTITY PRIMARY KEY, name NVARCHAR(64) NOT NULL, marker NVARCHAR(64) NOT NULL);
DELETE FROM customers;
INSERT INTO customers (name, marker) VALUES ('Ada','MS-GAMMA'),('Grace','MS-GAMMA'),('Linus','MS-GAMMA');
