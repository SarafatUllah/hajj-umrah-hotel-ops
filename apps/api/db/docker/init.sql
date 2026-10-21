SELECT 'CREATE DATABASE hajj_umrah_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hajj_umrah_test')\gexec

\c hajj_umrah_dev
CREATE EXTENSION IF NOT EXISTS btree_gist;

\c hajj_umrah_test
CREATE EXTENSION IF NOT EXISTS btree_gist;
