-- Create products table
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    stock INTEGER NOT NULL CHECK (stock >= 0)
);

-- Seed initial products (at least 5 sample products)
INSERT INTO products (name, description, price, stock) VALUES
    ('Laptop', 'A powerful laptop', 1200.00, 50),
    ('Smartphone', 'High-end smartphone with OLED screen', 799.99, 100),
    ('Wireless Headphones', 'Noise-canceling over-ear headphones', 199.99, 150),
    ('Mechanical Keyboard', 'RGB mechanical keyboard with tactile switches', 89.99, 80),
    ('Gaming Mouse', 'Ergonomic gaming mouse with high DPI sensor', 49.99, 120),
    ('4K Monitor', 'Ultra HD 27-inch IPS display', 349.50, 45)
ON CONFLICT (id) DO NOTHING;
