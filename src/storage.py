# stores persistent bot count data for recovery/reference/tracking using sqlite3 db stored in ~/sqlite/storage

import sqlite3
import os


class Storage:
    def __init__(self):
        os.makedirs('sqlite', exist_ok=True)  # creates directory for db
        con = sqlite3.connect('/sqlite/storage')  # creating db object
        cur = con.cursor()  # selecting db object
        cur.execute("create table metrics (server_name, user, high_score)")  # creating user metrics table
        cur.execute("create table current_count (server_name, user, current_score, last_user)")  # create counts
