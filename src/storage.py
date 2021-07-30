# stores persistent bot count data for recovery/reference/tracking using sqlite3 db stored in ~/sqlite/storage

import sqlite3
import os
import sqlalchemy as db
from sqlalchemy import Table, Column, Integer, String, MetaData


class Storage:
    def __init__(self):
        os.makedirs("sqlite", exist_ok=True)  # creates directory for db
        engine = db.create_engine("sqlite:///sqlite/storage.db")
        connection = engine.connect()
        meta = MetaData()
        metrics = Table(
            "metrics",
            meta,
            Column("id", Integer, primary_key=True),
            Column("server_name", String),
            Column("user", String),
            Column("high_score", Integer),
        )
        current_count = Table(
            "current_count",
            meta,
            Column("id", Integer, primary_key=True),
            Column("server_name", String),
            Column("user", String),
            Column("current_score", Integer),
        )
        meta.create_all(engine)


driver = Storage()
