// SQL 工具：MySQL / SQLite / PostgreSQL 查询与测试
use postgres::fallible_iterator::FallibleIterator;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MAX_ROWS: usize = 500;
const QUERY_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SqlProfile {
    pub kind: String,
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub file: Option<String>,
    /// 使用 TLS 加密连接（PostgreSQL: require；MySQL: 默认 CA 校验）
    #[serde(default)]
    pub ssl: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlTestResult {
    pub kind: String,
    pub server_version: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub affected: u64,
    pub elapsed_ms: u64,
    pub truncated: bool,
    pub is_query: bool,
}

fn first_keyword(sql: &str) -> String {
    let mut keyword = String::new();
    for ch in sql.chars() {
        if ch.is_ascii_alphabetic() {
            keyword.push(ch.to_ascii_uppercase());
        } else if !keyword.is_empty() || (!ch.is_whitespace() && ch != '(' && ch != ';') {
            break;
        }
    }
    keyword
}

fn is_query_sql(sql: &str) -> bool {
    matches!(
        first_keyword(sql).as_str(),
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PRAGMA" | "WITH" | "VALUES"
    )
}

fn mysql_value_to_json(value: mysql::Value) -> Value {
    match value {
        mysql::Value::NULL => Value::Null,
        mysql::Value::Bytes(bytes) => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
        mysql::Value::Int(number) => json!(number),
        mysql::Value::UInt(number) => json!(number),
        mysql::Value::Float(number) => json!(number),
        mysql::Value::Double(number) => json!(number),
        mysql::Value::Date(year, month, day, hour, minute, second, micros) => Value::String(format!(
            "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}{}",
            if micros > 0 { format!(".{:06}", micros) } else { String::new() }
        )),
        mysql::Value::Time(negative, days, hour, minute, second, micros) => Value::String(format!(
            "{}{} days {hour:02}:{minute:02}:{second:02}{}",
            if negative { "-" } else { "" },
            days,
            if micros > 0 { format!(".{:06}", micros) } else { String::new() }
        )),
    }
}

fn mysql_exec(profile: &SqlProfile, sql: &str, max_rows: usize) -> Result<SqlExecResult, String> {
    use mysql::prelude::*;
    with_mysql(profile, None, |conn| {
        let started = Instant::now();
        let query = is_query_sql(sql);
        let mut result = conn
            .query_iter(sql)
            .map_err(|error| format!("SQL 执行失败：{error}"))?;
        let columns = result
            .columns()
            .as_ref()
            .iter()
            .map(|column| column.name_str().to_string())
            .collect::<Vec<_>>();
        let mut rows = Vec::new();
        let mut truncated = false;
        for row in result.by_ref() {
            let row = row.map_err(|error| format!("读取结果失败：{error}"))?;
            rows.push(row.unwrap().into_iter().map(mysql_value_to_json).collect::<Vec<_>>());
            if rows.len() >= max_rows {
                truncated = true;
                break;
            }
        }
        drop(result);
        let affected = conn.affected_rows();
        Ok(SqlExecResult {
            columns,
            rows,
            affected,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated,
            is_query: query,
        })
    })
}

fn sqlite_value_to_json(value: rusqlite::types::Value) -> Value {
    match value {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(number) => json!(number),
        rusqlite::types::Value::Real(number) => json!(number),
        rusqlite::types::Value::Text(text) => Value::String(text),
        rusqlite::types::Value::Blob(bytes) => Value::String(format!("0x{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())),
    }
}

fn sqlite_exec(profile: &SqlProfile, sql: &str, max_rows: usize) -> Result<SqlExecResult, String> {
    let conn = sqlite_take(profile)?;
    sqlite_exec_on(conn, profile, sql, max_rows)
}

/// 在已取出的 SQLite 连接上执行；连接由调用方管理（取走后必须由本函数归还缓存）。
fn sqlite_exec_on(
    conn: rusqlite::Connection,
    profile: &SqlProfile,
    sql: &str,
    max_rows: usize,
) -> Result<SqlExecResult, String> {
    let started = Instant::now();
    if is_query_sql(sql) {
        let mut stmt = conn.prepare(sql).map_err(|error| format!("SQL 解析失败：{error}"))?;
        let columns = stmt.column_names().iter().map(|name| name.to_string()).collect::<Vec<_>>();
        let mut rows = Vec::new();
        let mut truncated = false;
        let mut rows_iter = stmt.query([]).map_err(|error| format!("SQL 执行失败：{error}"))?;
        while let Some(row) = rows_iter.next().map_err(|error| format!("读取结果失败：{error}"))? {
            let mut cells = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                let value = row.get::<usize, rusqlite::types::Value>(index).unwrap_or(rusqlite::types::Value::Null);
                cells.push(sqlite_value_to_json(value));
            }
            rows.push(cells);
            if rows.len() >= max_rows {
                truncated = true;
                break;
            }
        }
        let affected = rows.len() as u64;
        drop(rows_iter);
        drop(stmt);
        let result = SqlExecResult {
            columns,
            rows,
            affected,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated,
            is_query: true,
        };
        sqlite_put(profile, conn);
        Ok(result)
    } else {
        // execute_batch 支持多语句脚本（dump/迁移文件）；
        // affected 取「本次调用」的变更行数差值（total_changes 是连接累计值）
        let before = conn.total_changes();
        conn.execute_batch(sql)
            .map_err(|error| format!("SQL 执行失败：{error}"))?;
        let result = SqlExecResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected: conn.total_changes() - before,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated: false,
            is_query: false,
        };
        sqlite_put(profile, conn);
        Ok(result)
    }
}

fn pg_cell(row: &postgres::Row, index: usize) -> Value {
    if let Ok(value) = row.try_get::<usize, Value>(index) {
        return value;
    }
    if let Ok(value) = row.try_get::<usize, Option<String>>(index) {
        return value.map_or(Value::Null, Value::String);
    }
    if let Ok(value) = row.try_get::<usize, Option<i64>>(index) {
        return value.map_or(Value::Null, |number| json!(number));
    }
    if let Ok(value) = row.try_get::<usize, Option<f64>>(index) {
        return value.map_or(Value::Null, |number| json!(number));
    }
    if let Ok(value) = row.try_get::<usize, Option<bool>>(index) {
        return value.map_or(Value::Null, |flag| json!(flag));
    }
    Value::Null
}

fn pg_exec(profile: &SqlProfile, sql: &str, max_rows: usize) -> Result<SqlExecResult, String> {
    with_pg(profile, None, |client| {
        let started = Instant::now();
        if is_query_sql(sql) {
            // query_raw 流式读取：达到 MAX_ROWS 即停止，避免大表全量载入内存
            let mut rows_iter = client
                .query_raw(sql, std::iter::empty::<&(dyn postgres::types::ToSql + Sync)>())
                .map_err(|error| format!("SQL 执行失败：{error}"))?;
            let mut out = Vec::new();
            let mut truncated = false;
            let mut columns: Vec<String> = Vec::new();
            while let Some(row) = rows_iter
                .next()
                .map_err(|error| format!("读取结果失败：{error}"))?
            {
                if columns.is_empty() {
                    columns = row
                        .columns()
                        .iter()
                        .map(|column| column.name().to_string())
                        .collect::<Vec<_>>();
                }
                out.push((0..columns.len()).map(|index| pg_cell(&row, index)).collect::<Vec<_>>());
                if out.len() >= max_rows {
                    truncated = true;
                    break;
                }
            }
            Ok(SqlExecResult {
                columns,
                rows: out,
                affected: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
                truncated,
                is_query: true,
            })
        } else {
            let affected = client
                .execute(sql, &[])
                .map_err(|error| format!("SQL 执行失败：{error}"))?;
            Ok(SqlExecResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected,
                elapsed_ms: started.elapsed().as_millis() as u64,
                truncated: false,
                is_query: false,
            })
        }
    })
}

fn run_sql(profile: &SqlProfile, sql: &str) -> Result<SqlExecResult, String> {
    match profile.kind.as_str() {
        "mysql" => mysql_exec(profile, sql, MAX_ROWS),
        "sqlite" => sqlite_exec(profile, sql, MAX_ROWS),
        "postgres" => pg_exec(profile, sql, MAX_ROWS),
        other => Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    }
}

fn run_test(profile: &SqlProfile) -> Result<SqlTestResult, String> {
    let started = Instant::now();
    let version = match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            let mut conn = mysql_conn_with(profile, None, |opts| opts)?;
            let value: Option<String> = conn.query_first("SELECT VERSION()").map_err(|error| format!("查询版本失败：{error}"))?;
            value.unwrap_or_else(|| "未知".into())
        }
        "sqlite" => {
            let path = profile.file.as_deref().filter(|path| !path.trim().is_empty()).ok_or("SQLite 需要指定数据库文件路径")?;
            let conn = rusqlite::Connection::open(path).map_err(|error| format!("打开 SQLite 失败：{error}"))?;
            conn.query_row("SELECT sqlite_version()", [], |row| row.get::<_, String>(0))
                .map_err(|error| format!("查询版本失败：{error}"))?
        }
        "postgres" => {
            let mut config = postgres::Config::new();
            config.host(profile.host.trim());
            config.port(profile.port.unwrap_or(5432));
            config.user(profile.user.as_deref().unwrap_or_default());
            config.password(profile.password.as_deref().unwrap_or_default());
            if let Some(database) = profile.database.as_deref().filter(|name| !name.trim().is_empty()) {
                config.dbname(database);
            }
            let mut client = pg_connect(&mut config, profile.ssl)?;
            let row = client.query_one("SELECT version()", &[]).map_err(|error| format!("查询版本失败：{error}"))?;
            row.try_get::<_, String>(0).unwrap_or_else(|_| "未知".into())
        }
        other => return Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    };
    Ok(SqlTestResult {
        kind: profile.kind.clone(),
        server_version: version,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn sql_test(profile: SqlProfile) -> Result<SqlTestResult, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_test(&profile));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task)
        .await
        .map_err(|_| "连接测试超过 15 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_execute(profile: SqlProfile, sql: String) -> Result<SqlExecResult, String> {
    let sql = sql.trim().to_string();
    if sql.is_empty() {
        return Err("SQL 不能为空".into());
    }
    // SQLite：通过 interrupt_handle 真正取消超时查询，避免后台任务堆积/连接错乱
    if profile.kind == "sqlite" {
        let conn = sqlite_take(&profile)?;
        let interrupt = conn.get_interrupt_handle();
        let task = tauri::async_runtime::spawn_blocking(move || sqlite_exec_on(conn, &profile, &sql, MAX_ROWS));
        return match tokio::time::timeout(std::time::Duration::from_secs(QUERY_TIMEOUT_SECS), task).await {
            Ok(joined) => joined.map_err(|error| format!("数据库任务失败：{error}"))?,
            Err(_) => {
                // 真正中断底层 SQLite 查询：任务随即结束并把连接归还缓存
                interrupt.interrupt();
                Err(format!("SQL 执行超过 {QUERY_TIMEOUT_SECS} 秒，已中断查询"))
            }
        };
    }
    let task = tauri::async_runtime::spawn_blocking(move || run_sql(&profile, &sql));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(QUERY_TIMEOUT_SECS), task)
        .await
        .map_err(|_| format!("SQL 执行超过 {QUERY_TIMEOUT_SECS} 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作"))?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}
// ── 元数据浏览与数据编辑（Navicat 风格） ──────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlTableInfo {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: String,
    pub default: Option<String>,
    pub extra: String,
    pub comment: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRowsResult {
    pub columns: Vec<SqlColumnInfo>,
    pub rows: Vec<Vec<Value>>,
    pub total: u64,
    pub offset: u64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SqlCellRef {
    pub column: String,
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SqlColumnDef {
    pub name: String,
    pub data_type: String,
    pub length: Option<u32>,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SqlColumnChange {
    #[serde(flatten)]
    pub def: SqlColumnDef,
    pub old_name: Option<String>,
}


/* ── 连接缓存：SQLite 保证 :memory:/临时库跨命令持久；MySQL/PostgreSQL 复用连接，
   让「已连接」状态真实对应一个可复用连接（临时表/事务/会话变量可跨命令保持） ── */
enum CachedSqlConn {
    Sqlite(rusqlite::Connection),
    Mysql(mysql::Conn),
    Pg(postgres::Client),
}

fn conn_cache() -> &'static Mutex<HashMap<String, CachedSqlConn>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSqlConn>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 连接缓存 key 必须包含「实际生效的数据库」：命令级 database 优先于 profile.database，
/// 否则切换数据库时会错误复用上一个库的连接。
fn sql_cache_key(profile: &SqlProfile, database: Option<&str>) -> String {
    let database = database.or(profile.database.as_deref()).unwrap_or("");
    match profile.kind.as_str() {
        "sqlite" => format!("sqlite|{}", profile.file.as_deref().unwrap_or("")),
        "mysql" => format!(
            "mysql|{}|{}|{}|{}|{}",
            profile.host.trim(),
            profile.port.unwrap_or(3306),
            profile.user.as_deref().unwrap_or(""),
            database,
            profile.ssl
        ),
        "postgres" => format!(
            "postgres|{}|{}|{}|{}|{}",
            profile.host.trim(),
            profile.port.unwrap_or(5432),
            profile.user.as_deref().unwrap_or(""),
            database,
            profile.ssl
        ),
        other => other.to_string(),
    }
}

/// 从缓存取出连接（不存在或类型不符返回 None）。
fn conn_take(profile: &SqlProfile, database: Option<&str>) -> Option<CachedSqlConn> {
    let key = sql_cache_key(profile, database);
    conn_cache().lock().ok()?.remove(&key)
}

/// 成功使用后归还连接；失败路径应直接 drop，避免复用坏连接。
fn conn_put(profile: &SqlProfile, database: Option<&str>, conn: CachedSqlConn) {
    if let Ok(mut cache) = conn_cache().lock() {
        cache.insert(sql_cache_key(profile, database), conn);
    }
}

fn sqlite_take(profile: &SqlProfile) -> Result<rusqlite::Connection, String> {
    match conn_take(profile, None) {
        Some(CachedSqlConn::Sqlite(conn)) => Ok(conn),
        _ => sqlite_conn(profile),
    }
}

fn sqlite_put(profile: &SqlProfile, conn: rusqlite::Connection) {
    conn_put(profile, None, CachedSqlConn::Sqlite(conn));
}

/// MySQL：优先复用缓存连接；成功归还，失败丢弃。
fn with_mysql<T>(
    profile: &SqlProfile,
    database: Option<&str>,
    f: impl FnOnce(&mut mysql::Conn) -> Result<T, String>,
) -> Result<T, String> {
    let mut conn = match conn_take(profile, database) {
        Some(CachedSqlConn::Mysql(conn)) => conn,
        _ => open_mysql(profile, database)?,
    };
    let result = f(&mut conn);
    match result {
        Ok(value) => {
            conn_put(profile, database, CachedSqlConn::Mysql(conn));
            Ok(value)
        }
        Err(error) => {
            drop(conn);
            Err(error)
        }
    }
}

/// PostgreSQL：优先复用缓存连接；成功归还，失败丢弃。
fn with_pg<T>(
    profile: &SqlProfile,
    database: Option<&str>,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, String>,
) -> Result<T, String> {
    let mut client = match conn_take(profile, database) {
        Some(CachedSqlConn::Pg(client)) => client,
        _ => pg_client(profile, database)?,
    };
    let result = f(&mut client);
    match result {
        Ok(value) => {
            conn_put(profile, database, CachedSqlConn::Pg(client));
            Ok(value)
        }
        Err(error) => {
            drop(client);
            Err(error)
        }
    }
}

fn quote_ident(kind: &str, name: &str) -> String {
    match kind {
        "mysql" => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn mysql_conn_with(
    profile: &SqlProfile,
    database: Option<&str>,
    extra: impl FnOnce(mysql::OptsBuilder) -> mysql::OptsBuilder,
) -> Result<mysql::Conn, String> {
    let mut opts = mysql::OptsBuilder::new()
        .ip_or_hostname(Some(profile.host.trim()))
        .tcp_port(profile.port.unwrap_or(3306))
        .user(Some(profile.user.clone().unwrap_or_default()))
        .pass(Some(profile.password.clone().unwrap_or_default()))
        .db_name(database.or(profile.database.as_deref()).map(|name| name.to_string()));
    if profile.ssl {
        opts = opts.ssl_opts(mysql::SslOpts::default());
    }
    let opts = extra(opts);
    mysql::Conn::new(opts).map_err(|error| format!("连接 MySQL 失败：{error}"))
}

fn pg_connect(config: &mut postgres::Config, ssl: bool) -> Result<postgres::Client, String> {
    if ssl {
        let connector = postgres_native_tls::MakeTlsConnector::new(
            native_tls::TlsConnector::new().map_err(|error| format!("创建 TLS 连接器失败：{error}"))?,
        );
        config.ssl_mode(postgres::config::SslMode::Require);
        config
            .connect(connector)
            .map_err(|error| format!("连接 PostgreSQL 失败：{error}"))
    } else {
        config
            .connect(postgres::NoTls)
            .map_err(|error| format!("连接 PostgreSQL 失败：{error}"))
    }
}

fn open_mysql(profile: &SqlProfile, database: Option<&str>) -> Result<mysql::Conn, String> {
    mysql_conn_with(profile, database, |opts| {
        opts.tcp_connect_timeout(Some(std::time::Duration::from_secs(10)))
            .read_timeout(Some(std::time::Duration::from_secs(QUERY_TIMEOUT_SECS)))
            .write_timeout(Some(std::time::Duration::from_secs(QUERY_TIMEOUT_SECS)))
    })
}

fn pg_client(profile: &SqlProfile, database: Option<&str>) -> Result<postgres::Client, String> {
    let mut config = postgres::Config::new();
    config.host(profile.host.trim());
    config.port(profile.port.unwrap_or(5432));
    config.user(profile.user.as_deref().unwrap_or_default());
    config.password(profile.password.as_deref().unwrap_or_default());
    let name = database.or(profile.database.as_deref()).filter(|name| !name.trim().is_empty()).unwrap_or("postgres");
    config.dbname(name);
    config.connect_timeout(std::time::Duration::from_secs(10));
    pg_connect(&mut config, profile.ssl)
}

fn sqlite_conn(profile: &SqlProfile) -> Result<rusqlite::Connection, String> {
    let path = profile.file.as_deref().filter(|path| !path.trim().is_empty()).ok_or("SQLite 需要指定数据库文件路径")?;
    rusqlite::Connection::open(path).map_err(|error| format!("打开 SQLite 失败：{error}"))
}

fn run_databases(profile: &SqlProfile) -> Result<Vec<String>, String> {
    match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, None, |conn| {
                let names: Vec<String> = conn.query("SHOW DATABASES").map_err(|error| format!("查询数据库列表失败：{error}"))?;
                Ok(names)
            })
        }
        "postgres" => {
            with_pg(profile, None, |client| {
                let rows = client
                    .query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname", &[])
                    .map_err(|error| format!("查询数据库列表失败：{error}"))?;
                Ok(rows.iter().map(|row| row.get::<_, String>(0)).collect())
            })
        }
        "sqlite" => {
            let _ = sqlite_conn(profile)?;
            let label = profile.file.as_deref().filter(|path| !path.trim().is_empty())
                .map(|path| path.rsplit(['/', '\\']).next().unwrap_or(path).to_string())
                .unwrap_or_else(|| "main".into());
            Ok(vec![label])
        }
        other => Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    }
}

fn run_tables(profile: &SqlProfile, database: String) -> Result<Vec<SqlTableInfo>, String> {
    match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, Some(&database.clone()), |conn| {
                let rows: Vec<(String, String)> = conn
                    .exec("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name", vec![database])
                    .map_err(|error| format!("查询表列表失败：{error}"))?;
                Ok(rows.into_iter().map(|(name, kind)| SqlTableInfo { name, kind: if kind == "BASE TABLE" { "TABLE".into() } else { kind } }).collect())
            })
        }
        "postgres" => {
            with_pg(profile, Some(&database), |client| {
                let rows = client
                    .query("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name", &[])
                    .map_err(|error| format!("查询表列表失败：{error}"))?;
                Ok(rows.iter().map(|row| SqlTableInfo {
                    name: row.get::<_, String>(0),
                    kind: {
                        let kind: String = row.get(1);
                        if kind == "BASE TABLE" { "TABLE".into() } else { kind }
                    },
                }).collect())
            })
        }
        "sqlite" => {
            let conn = sqlite_take(profile)?;
            let mut stmt = conn
                .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .map_err(|error| format!("查询表列表失败：{error}"))?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| format!("查询表列表失败：{error}"))?;
            let mut out = Vec::new();
            for row in rows {
                let (name, kind) = row.map_err(|error| format!("读取表列表失败：{error}"))?;
                out.push(SqlTableInfo { name, kind: kind.to_uppercase() });
            }
            drop(stmt);
            sqlite_put(profile, conn);
            Ok(out)
        }
        other => Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    }
}

/// MySQL information_schema.columns 单行：列名、类型、可空、键、默认值、额外、注释
type MysqlColumnRow = (String, String, String, String, Option<String>, String, String);

fn run_columns(profile: &SqlProfile, database: String, table: String) -> Result<Vec<SqlColumnInfo>, String> {
    let quoted = quote_ident(&profile.kind, &table);
    match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, Some(&database.clone()), |conn| {
                let rows: Vec<MysqlColumnRow> = conn
                    .exec(
                        "SELECT column_name, data_type, is_nullable, column_key, column_default, extra, column_comment FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
                        vec![database, table],
                    )
                    .map_err(|error| format!("查询字段失败：{error}"))?;
                Ok(rows.into_iter().map(|(name, data_type, nullable, key, default, extra, comment)| SqlColumnInfo {
                    name, data_type, nullable: nullable == "YES", key, default, extra, comment,
                }).collect())
            })
        }
        "postgres" => {
            with_pg(profile, Some(&database), |client| {
                let rows = client
                    .query(
                        "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = $1 ORDER BY c.ordinal_position",
                        &[&table],
                    )
                    .map_err(|error| format!("查询字段失败：{error}"))?;
                let pk_rows = client
                    .query(
                        "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary",
                        &[&format!("public.\"{}\"", table)],
                    )
                    .map_err(|error| format!("查询主键失败：{error}"))?;
                let pk: Vec<String> = pk_rows.iter().map(|row| row.get::<_, String>(0)).collect();
                Ok(rows.iter().map(|row| SqlColumnInfo {
                    name: row.get::<_, String>(0),
                    data_type: row.get::<_, String>(1),
                    nullable: row.get::<_, String>(2) == "YES",
                    key: if pk.contains(&row.get::<_, String>(0)) { "PRI".into() } else { String::new() },
                    default: row.get::<_, Option<String>>(3),
                    extra: String::new(),
                    comment: row.get::<_, Option<String>>(4).unwrap_or_default(),
                }).collect())
            })
        }
        "sqlite" => {
            let conn = sqlite_take(profile)?;
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({quoted})")).map_err(|error| format!("查询字段失败：{error}"))?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, i64>(5)?)))
                .map_err(|error| format!("查询字段失败：{error}"))?;
            let mut out = Vec::new();
            for row in rows {
                let (name, data_type, notnull, default, pk) = row.map_err(|error| format!("读取字段失败：{error}"))?;
                out.push(SqlColumnInfo {
                    name,
                    data_type: if data_type.is_empty() { "TEXT".into() } else { data_type },
                    nullable: notnull == 0,
                    key: if pk > 0 { "PRI".into() } else { String::new() },
                    default,
                    extra: String::new(),
                    comment: String::new(),
                });
            }
            drop(stmt);
            sqlite_put(profile, conn);
            Ok(out)
        }
        other => Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    }
}

fn run_rows(
    profile: &SqlProfile,
    database: String,
    table: String,
    offset: u64,
    limit: u64,
    filter: Option<String>,
) -> Result<SqlRowsResult, String> {
    let columns = run_columns(profile, database.clone(), table.clone())?;
    let quoted = quote_ident(&profile.kind, &table);
    // 跨页 SQL 条件：追加到 WHERE（用户自担语义），空值跳过
    let where_clause = filter
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| format!(" WHERE ({value})"))
        .unwrap_or_default();
    let rows = match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, Some(&database), |conn| {
                let total: u64 = conn.query_first(format!("SELECT COUNT(*) FROM {quoted}{where_clause}")).map_err(|error| format!("统计行数失败：{error}"))?.unwrap_or(0);
                let mut result = conn
                    .exec_iter(format!("SELECT * FROM {quoted}{where_clause} LIMIT ? OFFSET ?"), (limit, offset))
                    .map_err(|error| format!("查询数据失败：{error}"))?;
                let mut out = Vec::new();
                for row in result.by_ref() {
                    let row = row.map_err(|error| format!("读取数据失败：{error}"))?;
                    out.push(row.unwrap().into_iter().map(mysql_value_to_json).collect::<Vec<_>>());
                }
                Ok((out, total))
            })
        }
        "postgres" => {
            with_pg(profile, Some(&database), |client| {
                let total: i64 = client.query_one(&format!("SELECT COUNT(*) FROM {quoted}{where_clause}"), &[]).map_err(|error| format!("统计行数失败：{error}"))?.get(0);
                let result = client
                    .query(&format!("SELECT * FROM {quoted}{where_clause} LIMIT $1 OFFSET $2"), &[&(limit as i64), &(offset as i64)])
                    .map_err(|error| format!("查询数据失败：{error}"))?;
                let out = result.iter().map(|row| (0..columns.len()).map(|index| pg_cell(row, index)).collect::<Vec<_>>()).collect::<Vec<_>>();
                Ok((out, total as u64))
            })
        }
        "sqlite" => {
            let conn = sqlite_take(profile)?;
            let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {quoted}{where_clause}"), [], |row| row.get(0)).map_err(|error| format!("统计行数失败：{error}"))?;
            let mut stmt = conn.prepare(&format!("SELECT * FROM {quoted}{where_clause} LIMIT ? OFFSET ?")).map_err(|error| format!("查询数据失败：{error}"))?;
            let rows_iter = stmt
                .query_map(rusqlite::params![limit as i64, offset as i64], |row| {
                    let mut cells = Vec::with_capacity(columns.len());
                    for index in 0..columns.len() {
                        let value = row.get::<usize, rusqlite::types::Value>(index).unwrap_or(rusqlite::types::Value::Null);
                        cells.push(sqlite_value_to_json(value));
                    }
                    Ok(cells)
                })
                .map_err(|error| format!("查询数据失败：{error}"))?;
            let mut out = Vec::new();
            for row in rows_iter {
                out.push(row.map_err(|error| format!("读取数据失败：{error}"))?);
            }
            drop(stmt);
            sqlite_put(profile, conn);
            Ok((out, total as u64))
        }
        other => return Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    }?;
    Ok(SqlRowsResult { columns, rows: rows.0, total: rows.1, offset })
}

fn pg_type_map(profile: &SqlProfile, database: String, table: &str) -> Result<std::collections::HashMap<String, String>, String> {
    with_pg(profile, Some(&database), |client| {
        let rows = client
            .query(
                "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
                &[&table],
            )
            .map_err(|error| format!("查询字段类型失败：{error}"))?;
        let mut map = std::collections::HashMap::new();
        for row in rows {
            let mut ty: String = row.get(1);
            if ty == "ARRAY" || ty == "USER-DEFINED" {
                ty = "text".into();
            }
            map.insert(row.get::<_, String>(0), ty);
        }
        Ok(map)
    })
}

fn pg_cast_type(map: &std::collections::HashMap<String, String>, column: &str) -> String {
    map.get(column).cloned().unwrap_or_else(|| "text".into())
}

fn run_update_row(profile: &SqlProfile, database: String, table: String, keys: Vec<SqlCellRef>, changes: Vec<SqlCellRef>) -> Result<u64, String> {
    if keys.is_empty() {
        return Err("缺少用于定位行的主键/原始值".into());
    }
    if changes.is_empty() {
        return Ok(0);
    }
    let quoted = quote_ident(&profile.kind, &table);
    let result = match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, Some(&database), |conn| {
                let set: Vec<String> = changes.iter().map(|c| format!("{} = ?", quote_ident("mysql", &c.column))).collect();
                let where_clause: Vec<String> = keys.iter().map(|k| format!("{} = ?", quote_ident("mysql", &k.column))).collect();
                let sql = format!("UPDATE {quoted} SET {} WHERE {}", set.join(", "), where_clause.join(" AND "));
                let mut params: Vec<mysql::Value> = Vec::new();
                for c in &changes {
                    params.push(match &c.value { Some(v) => mysql::Value::from(v.clone()), None => mysql::Value::NULL });
                }
                for k in &keys {
                    params.push(match &k.value { Some(v) => mysql::Value::from(v.clone()), None => mysql::Value::NULL });
                }
                conn.exec_drop(sql, params).map_err(|error| format!("更新数据失败：{error}"))?;
                Ok(conn.affected_rows())
            })
        }
        "postgres" => {
            let types = pg_type_map(profile, database.clone(), &table)?;
            with_pg(profile, Some(&database), |client| {
                let set: Vec<String> = changes.iter().enumerate()
                    .map(|(i, c)| format!("{} = ${}::{}", quote_ident("postgres", &c.column), i + 1, pg_cast_type(&types, &c.column)))
                    .collect();
                let base = changes.len();
                let where_clause: Vec<String> = keys.iter().enumerate()
                    .map(|(i, k)| format!("{} = ${}::{}", quote_ident("postgres", &k.column), base + i + 1, pg_cast_type(&types, &k.column)))
                    .collect();
                let sql = format!("UPDATE {quoted} SET {} WHERE {}", set.join(", "), where_clause.join(" AND "));
                let mut params: Vec<Option<String>> = changes.iter().map(|c| c.value.clone()).collect();
                params.extend(keys.iter().map(|k| k.value.clone()));
                let refs: Vec<&(dyn postgres::types::ToSql + Sync)> = params.iter().map(|p| p as &(dyn postgres::types::ToSql + Sync)).collect();
                let affected = client.execute(&sql, &refs).map_err(|error| format!("更新数据失败：{error}"))?;
                Ok(affected)
            })
        }
        "sqlite" => {
            let conn = sqlite_take(profile)?;
            let set: Vec<String> = changes.iter().map(|c| format!("{} = ?", quote_ident("sqlite", &c.column))).collect();
            let where_clause: Vec<String> = keys.iter().map(|k| format!("{} = ?", quote_ident("sqlite", &k.column))).collect();
            let sql = format!("UPDATE {quoted} SET {} WHERE {}", set.join(", "), where_clause.join(" AND "));
            let mut params: Vec<rusqlite::types::Value> = Vec::new();
            for c in &changes {
                params.push(match &c.value { Some(v) => rusqlite::types::Value::Text(v.clone()), None => rusqlite::types::Value::Null });
            }
            for k in &keys {
                params.push(match &k.value { Some(v) => rusqlite::types::Value::Text(v.clone()), None => rusqlite::types::Value::Null });
            }
            let affected = conn.execute(&sql, rusqlite::params_from_iter(params)).map_err(|error| format!("更新数据失败：{error}"))?;
            sqlite_put(profile, conn);
            Ok(affected as u64)
        }
        other => return Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    }?;
    Ok(result)
}

fn run_insert_row(profile: &SqlProfile, database: String, table: String, columns: Vec<String>, values: Vec<Option<String>>) -> Result<u64, String> {
    if columns.is_empty() || columns.len() != values.len() {
        return Err("新增行数据不完整".into());
    }
    let quoted = quote_ident(&profile.kind, &table);
    let cols = columns.iter().map(|c| quote_ident(&profile.kind, c)).collect::<Vec<_>>();
    let result = match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, Some(&database), |conn| {
                let placeholders = vec!["?".to_string(); values.len()].join(", ");
                let sql = format!("INSERT INTO {quoted} ({}) VALUES ({placeholders})", cols.join(", "));
                let params: Vec<mysql::Value> = values.iter().map(|v| match v { Some(s) => mysql::Value::from(s.clone()), None => mysql::Value::NULL }).collect();
                conn.exec_drop(sql, params).map_err(|error| format!("插入数据失败：{error}"))?;
                Ok(conn.affected_rows())
            })
        }
        "postgres" => {
            let types = pg_type_map(profile, database.clone(), &table)?;
            with_pg(profile, Some(&database), |client| {
                let placeholders: Vec<String> = columns.iter().enumerate()
                    .map(|(i, c)| format!("${}::{}", i + 1, pg_cast_type(&types, c)))
                    .collect();
                let sql = format!("INSERT INTO {quoted} ({}) VALUES ({})", cols.join(", "), placeholders.join(", "));
                let refs: Vec<&(dyn postgres::types::ToSql + Sync)> = values.iter().map(|v| v as &(dyn postgres::types::ToSql + Sync)).collect();
                let affected = client.execute(&sql, &refs).map_err(|error| format!("插入数据失败：{error}"))?;
                Ok(affected)
            })
        }
        "sqlite" => {
            let conn = sqlite_take(profile)?;
            let placeholders = vec!["?".to_string(); values.len()].join(", ");
            let sql = format!("INSERT INTO {quoted} ({}) VALUES ({placeholders})", cols.join(", "));
            let params: Vec<rusqlite::types::Value> = values.iter().map(|v| match v { Some(s) => rusqlite::types::Value::Text(s.clone()), None => rusqlite::types::Value::Null }).collect();
            let affected = conn.execute(&sql, rusqlite::params_from_iter(params)).map_err(|error| format!("插入数据失败：{error}"))?;
            sqlite_put(profile, conn);
            Ok(affected as u64)
        }
        other => return Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    }?;
    Ok(result)
}

fn run_delete_rows(profile: &SqlProfile, database: String, table: String, key_column: String, key_values: Vec<String>) -> Result<u64, String> {
    if key_values.is_empty() {
        return Ok(0);
    }
    let quoted = quote_ident(&profile.kind, &table);
    let col = quote_ident(&profile.kind, &key_column);
    let result = match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, Some(&database), |conn| {
                let placeholders = vec!["?".to_string(); key_values.len()].join(", ");
                let sql = format!("DELETE FROM {quoted} WHERE {col} IN ({placeholders})");
                let params: Vec<mysql::Value> = key_values.iter().map(|v| mysql::Value::from(v.clone())).collect();
                conn.exec_drop(sql, params).map_err(|error| format!("删除数据失败：{error}"))?;
                Ok(conn.affected_rows())
            })
        }
        "postgres" => {
            let types = pg_type_map(profile, database.clone(), &table)?;
            with_pg(profile, Some(&database), |client| {
                let ty = pg_cast_type(&types, &key_column);
                let placeholders: Vec<String> = (1..=key_values.len()).map(|i| format!("${i}::{ty}")).collect();
                let sql = format!("DELETE FROM {quoted} WHERE {col} IN ({})", placeholders.join(", "));
                let refs: Vec<&(dyn postgres::types::ToSql + Sync)> = key_values.iter().map(|v| v as &(dyn postgres::types::ToSql + Sync)).collect();
                let affected = client.execute(&sql, &refs).map_err(|error| format!("删除数据失败：{error}"))?;
                Ok(affected)
            })
        }
        "sqlite" => {
            let conn = sqlite_take(profile)?;
            let placeholders = vec!["?".to_string(); key_values.len()].join(", ");
            let sql = format!("DELETE FROM {quoted} WHERE {col} IN ({placeholders})");
            let params: Vec<rusqlite::types::Value> = key_values.iter().map(|v| rusqlite::types::Value::Text(v.clone())).collect();
            let affected = conn.execute(&sql, rusqlite::params_from_iter(params)).map_err(|error| format!("删除数据失败：{error}"))?;
            sqlite_put(profile, conn);
            Ok(affected as u64)
        }
        other => return Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    }?;
    Ok(result)
}

fn run_table_ddl(profile: &SqlProfile, database: String, table: String) -> Result<String, String> {
    let quoted = quote_ident(&profile.kind, &table);
    match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, Some(&database), |conn| {
                let sql = format!("SHOW CREATE TABLE {quoted}");
                let result = conn.query_first::<(String, String), _>(&sql);
                if let Ok(Some((_, ddl))) = result {
                    return Ok(ddl);
                }
                let sql = format!("SHOW CREATE VIEW {quoted}");
                let result = conn.query_first::<(String, String), _>(&sql).map_err(|error| format!("查询建表语句失败：{error}"))?;
                Ok(result.map(|(_, ddl)| ddl).unwrap_or_default())
            })
        }
        "sqlite" => {
            let conn = sqlite_take(profile)?;
            let ddl: Option<String> = conn
                .query_row("SELECT sql FROM sqlite_master WHERE name = ?", rusqlite::params![table], |row| row.get(0))
                .map_err(|error| format!("查询建表语句失败：{error}"))?;
            sqlite_put(profile, conn);
            Ok(ddl.unwrap_or_else(|| format!("CREATE TABLE {quoted} (未找到建表语句)")))
        }
        "postgres" => Err("PostgreSQL 暂不支持导出建表语句".into()),
        other => Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
    }
}

/* ── 表导出：结构 / 结构+数据 ────────────────────────────── */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlExportResult {
    pub filename: String,
    pub sql: String,
    pub rows: u64,
    pub truncated: bool,
}

fn sanitize_comment(text: &str) -> String {
    text.replace(['\r', '\n'], " ")
}

fn mysql_value_literal(value: &mysql::Value) -> String {
    match value {
        mysql::Value::NULL => "NULL".into(),
        mysql::Value::Int(i) => i.to_string(),
        mysql::Value::UInt(i) => i.to_string(),
        mysql::Value::Float(f) => f.to_string(),
        mysql::Value::Double(f) => f.to_string(),
        mysql::Value::Date(y, m, d, h, mi, s, us) => {
            if *h == 0 && *mi == 0 && *s == 0 && *us == 0 {
                format!("'{:04}-{:02}-{:02}'", y, m, d)
            } else {
                format!("'{:04}-{:02}-{:02} {:02}:{:02}:{:02}'", y, m, d, h, mi, s)
            }
        }
        mysql::Value::Time(_, _, _, _, _, _) => "NULL".into(),
        mysql::Value::Bytes(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => format!("'{}'", text.replace('\'', "''").replace('\\', "\\\\")),
            Err(_) => format!("X'{}'", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()),
        },
    }
}

fn sqlite_value_literal(value: &rusqlite::types::ValueRef<'_>) -> String {
    match value {
        rusqlite::types::ValueRef::Null => "NULL".into(),
        rusqlite::types::ValueRef::Integer(i) => i.to_string(),
        rusqlite::types::ValueRef::Real(f) => f.to_string(),
        rusqlite::types::ValueRef::Text(t) => match std::str::from_utf8(t) {
            Ok(text) => format!("'{}'", text.replace('\'', "''")),
            Err(_) => format!("X'{}'", t.iter().map(|byte| format!("{byte:02x}")).collect::<String>()),
        },
        rusqlite::types::ValueRef::Blob(b) => format!("X'{}'", b.iter().map(|byte| format!("{byte:02x}")).collect::<String>()),
    }
}

fn run_table_export(profile: &SqlProfile, database: String, table: String, with_data: bool) -> Result<SqlExportResult, String> {
    let quoted = quote_ident(&profile.kind, &table);
    let mut out = String::new();
    out.push_str("-- Spurh 表导出\n");
    out.push_str(&format!("-- 数据库: {} · 表: {}\n", sanitize_comment(&database), sanitize_comment(&table)));
    out.push_str("-- 导出时间: ");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let days = now / 86400;
    out.push_str(&format!("{} 天(自 1970) 之后\n\n", days));
    if profile.kind.as_str() != "postgres" {
        out.push_str(&format!("DROP TABLE IF EXISTS {quoted};\n"));
        out.push_str(&run_table_ddl(profile, database.clone(), table.clone())?);
        out.push_str(";\n\n");
    } else {
        out.push_str("-- PostgreSQL 暂不支持导出建表语句，以下仅含数据（COPY 格式）\n\n");
    }

    let mut rows: u64 = 0;
    let mut truncated = false;
    if with_data {
        match profile.kind.as_str() {
            "mysql" => {
                use mysql::prelude::*;
                with_mysql(profile, Some(&database), |conn| {
                    let sql = format!("SELECT * FROM {quoted}");
                    // query_iter 流式读取：达到上限即停止，避免大表全量载入内存
                    let mut result = conn.query_iter(sql).map_err(|error| format!("读取数据失败：{error}"))?;
                    let max_rows = 20_000;
                    for row in result.by_ref() {
                        if rows >= max_rows {
                            truncated = true;
                            break;
                        }
                        let row = row.map_err(|error| format!("读取数据失败：{error}"))?;
                        let values: Vec<String> = (0..row.len())
                            .map(|index| mysql_value_literal(row.as_ref(index).unwrap_or(&mysql::Value::NULL)))
                            .collect();
                        out.push_str(&format!("INSERT INTO {quoted} VALUES ({});\n", values.join(", ")));
                        rows += 1;
                    }
                    if truncated {
                        out.push_str(&format!("-- 数据超过 {max_rows} 行，已截断\n"));
                    }
                    Ok(())
                })?;
            }
            "sqlite" => {
                let conn = sqlite_take(profile)?;
                let mut stmt = conn
                    .prepare(&format!("SELECT * FROM {quoted}"))
                    .map_err(|error| format!("读取数据失败：{error}"))?;
                let column_count = stmt.column_count();
                let mut rows_iter = stmt.query([]).map_err(|error| format!("读取数据失败：{error}"))?;
                let max_rows = 20_000;
                let mut count: u64 = 0;
                while let Some(row) = rows_iter.next().map_err(|error| format!("读取数据失败：{error}"))? {
                    if count >= max_rows {
                        truncated = true;
                        break;
                    }
                    let mut values = Vec::with_capacity(column_count);
                    for index in 0..column_count {
                        let value = row.get_ref(index).map_err(|error| format!("读取数据失败：{error}"))?;
                        values.push(sqlite_value_literal(&value));
                    }
                    out.push_str(&format!("INSERT INTO {quoted} VALUES ({});\n", values.join(", ")));
                    count += 1;
                }
                rows = count;
                if truncated {
                    out.push_str(&format!("-- 数据超过 {max_rows} 行，已截断\n"));
                }
                drop(rows_iter);
                drop(stmt);
                sqlite_put(profile, conn);
            }
            "postgres" => {
                with_pg(profile, Some(&database), |client| {
                    let sql = format!("COPY {quoted} TO STDOUT");
                    let reader = client.copy_out(&sql).map_err(|error| format!("读取数据失败：{error}"))?;
                    let mut data = Vec::new();
                    let mut reader = reader;
                    use std::io::Read;
                    let max_bytes = 16 * 1024 * 1024;
                    // 流式读取：超过 16MB 立即截断，避免大表把全部数据载入内存
                    let mut chunk = [0u8; 65536];
                    loop {
                        match reader.read(&mut chunk) {
                            Ok(0) => break,
                            Ok(n) => {
                                data.extend_from_slice(&chunk[..n]);
                                if data.len() > max_bytes {
                                    truncated = true;
                                    break;
                                }
                            }
                            Err(error) => return Err(format!("读取数据失败：{error}")),
                        }
                    }
                    out.push_str(&format!("COPY {quoted} FROM stdin;\n"));
                    if truncated {
                        out.push_str(&String::from_utf8_lossy(&data[..max_bytes.min(data.len())]));
                        out.push_str("\n-- 数据超过 16MB，已截断\n");
                    } else {
                        out.push_str(&String::from_utf8_lossy(&data));
                    }
                    out.push_str("\\.\n");
                    rows = data.iter().filter(|byte| **byte == b'\n').count() as u64;
                    Ok(())
                })?;
            }
            other => return Err(format!("不支持的数据库类型：{other}（支持 mysql / sqlite / postgres）")),
        }
    }
    Ok(SqlExportResult {
        filename: format!("{database}_{table}.sql"),
        sql: out,
        rows,
        truncated,
    })
}

#[tauri::command]
pub async fn sql_export_table(profile: SqlProfile, database: String, table: String, with_data: bool) -> Result<SqlExportResult, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_table_export(&profile, database, table, with_data));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(60), task).await.map_err(|_| "导出超过 60 秒未返回，已超时；请缩小数据量后重试".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

/* ── 表设计器：建表 / 改表 DDL ────────────────────────────── */

fn default_literal(default: &str) -> String {
    let trimmed = default.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
        return "NULL".into();
    }
    if trimmed
        .to_ascii_uppercase()
        .matches(|ch: char| ch.is_ascii_alphabetic() || ch == '(' || ch == ')' || ch == '_')
        .collect::<String>()
        .is_empty()
    {
        // 纯数字/符号字面量原样输出
        return trimmed.into();
    }
    let upper = trimmed.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CURRENT_TIMESTAMP" | "CURRENT_DATE" | "CURRENT_TIME" | "NOW()" | "SYSDATE()" | "UUID()" | "GEN_RANDOM_UUID()" | "RANDOM()" | "TRUE" | "FALSE"
    ) {
        return trimmed.into();
    }
    format!("'{}'", trimmed.replace('\'', "''"))
}

fn column_type(kind: &str, def: &SqlColumnDef) -> String {
    let ty = def.data_type.trim().to_uppercase();
    let base = match kind {
        "mysql" => match ty.as_str() {
            "INT" => "INT".into(),
            "BIGINT" => "BIGINT".into(),
            "SMALLINT" => "SMALLINT".into(),
            "TINYINT" => "TINYINT".into(),
            "VARCHAR" | "CHAR" => ty.clone(),
            "DECIMAL" | "NUMERIC" | "DOUBLE" => ty.clone(),
            "TEXT" | "LONGTEXT" | "DATE" | "DATETIME" | "TIMESTAMP" | "TIME" | "FLOAT" | "BOOLEAN" | "BLOB" | "JSON" => ty.clone(),
            _ => {
                let cleaned = ty.replace(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'), "");
                if cleaned.is_empty() { "TEXT".into() } else { cleaned }
            }
        },
        "postgres" => match ty.as_str() {
            "INTEGER" | "INT" => "INTEGER".into(),
            "BIGINT" => "BIGINT".into(),
            "SMALLINT" => "SMALLINT".into(),
            "SERIAL" | "BIGSERIAL" => ty.clone(),
            "VARCHAR" | "CHAR" | "NUMERIC" | "DECIMAL" => ty.clone(),
            "DOUBLE PRECISION" => "DOUBLE PRECISION".into(),
            "TEXT" | "DATE" | "TIMESTAMP" | "TIME" | "REAL" | "BOOLEAN" | "JSONB" | "UUID" | "BYTEA" => ty.clone(),
            _ => {
                let cleaned = ty.replace(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == ' '), "");
                if cleaned.is_empty() { "TEXT".into() } else { cleaned }
            }
        },
        _ => match ty.as_str() {
            "INTEGER" | "INT" => "INTEGER".into(),
            "TEXT" => "TEXT".into(),
            "REAL" => "REAL".into(),
            "BLOB" => "BLOB".into(),
            "NUMERIC" => "NUMERIC".into(),
            "DATE" | "DATETIME" | "BOOLEAN" | "VARCHAR" | "CHAR" => ty.clone(),
            _ => {
                let cleaned = ty.replace(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'), "");
                if cleaned.is_empty() { "TEXT".into() } else { cleaned }
            }
        },
    };
    if let Some(length) = def.length {
        if matches!(base.as_str(), "VARCHAR" | "CHAR" | "DECIMAL" | "NUMERIC" | "DOUBLE" | "DOUBLE PRECISION") && length > 0 {
            return format!("{base}({length})");
        }
    }
    base
}

fn mysql_column_ddl(def: &SqlColumnDef) -> String {
    let name = quote_ident("mysql", &def.name);
    let ty = column_type("mysql", def);
    let mut parts = vec![format!("{name} {ty}")];
    if def.auto_increment {
        parts.push("AUTO_INCREMENT".into());
    }
    if !def.nullable && !def.primary_key && !def.auto_increment {
        parts.push("NOT NULL".into());
    }
    if let Some(default) = &def.default {
        parts.push(format!("DEFAULT {}", default_literal(default)));
    }
    if let Some(comment) = &def.comment {
        if !comment.trim().is_empty() {
            parts.push(format!("COMMENT '{}'", comment.replace('\'', "''")));
        }
    }
    parts.join(" ")
}

fn pg_column_ddl(def: &SqlColumnDef) -> String {
    let name = quote_ident("postgres", &def.name);
    let ty = column_type("postgres", def);
    if def.auto_increment {
        let serial = match ty.as_str() {
            "BIGINT" => "BIGSERIAL",
            "SMALLINT" => "SMALLSERIAL",
            _ => "SERIAL",
        };
        return format!("{name} {serial}");
    }
    let mut parts = vec![format!("{name} {ty}")];
    if !def.nullable && !def.primary_key {
        parts.push("NOT NULL".into());
    }
    if let Some(default) = &def.default {
        parts.push(format!("DEFAULT {}", default_literal(default)));
    }
    parts.join(" ")
}

fn sqlite_column_ddl(def: &SqlColumnDef) -> String {
    let name = quote_ident("sqlite", &def.name);
    let ty = column_type("sqlite", def);
    let mut parts = vec![format!("{name} {ty}")];
    if def.primary_key {
        parts.push("PRIMARY KEY".into());
    }
    if def.auto_increment {
        parts.push("AUTOINCREMENT".into());
    }
    if !def.nullable && !def.primary_key && !def.auto_increment {
        parts.push("NOT NULL".into());
    }
    if let Some(default) = &def.default {
        parts.push(format!("DEFAULT {}", default_literal(default)));
    }
    parts.join(" ")
}

fn pk_clause(kind: &str, columns: &[SqlColumnDef]) -> Option<String> {
    let pks: Vec<String> = columns.iter().filter(|col| col.primary_key).map(|col| quote_ident(kind, &col.name)).collect();
    if pks.is_empty() { None } else { Some(format!("PRIMARY KEY ({})", pks.join(", "))) }
}

fn run_create_table(profile: &SqlProfile, database: String, table: String, columns: Vec<SqlColumnDef>) -> Result<u64, String> {
    let table = table.trim().to_string();
    if table.is_empty() { return Err("表名不能为空".into()); }
    if columns.is_empty() { return Err("至少需要一个字段".into()); }
    for col in &columns {
        if col.name.trim().is_empty() { return Err("字段名不能为空".into()); }
        if col.data_type.trim().is_empty() { return Err(format!("字段「{}」缺少数据类型", col.name)); }
    }
    let quoted = quote_ident(&profile.kind, &table);
    let mut body: Vec<String> = match profile.kind.as_str() {
        "mysql" => columns.iter().map(mysql_column_ddl).collect(),
        "postgres" => columns.iter().map(pg_column_ddl).collect(),
        "sqlite" => columns.iter().map(sqlite_column_ddl).collect(),
        other => return Err(format!("不支持的数据库类型：{other}")),
    };
    if let Some(pk) = pk_clause(&profile.kind, &columns) {
        body.push(pk);
    }
    let sql = format!("CREATE TABLE {quoted} (
  {}
)", body.join(",
  "));
    match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            let mut conn = open_mysql(profile, Some(&database))?;
            conn.query_drop(&sql).map_err(|error| format!("建表失败：{error}"))?;
            Ok(1)
        }
        "postgres" => {
            let mut client = pg_client(profile, Some(&database))?;
            client.batch_execute(&sql).map_err(|error| format!("建表失败：{error}"))?;
            Ok(1)
        }
        "sqlite" => {
            let conn = sqlite_take(profile)?;
            let result = conn.execute_batch(&sql).map_err(|error| format!("建表失败：{error}"));
            sqlite_put(profile, conn);
            result.map(|_| 1)
        }
        _ => Err("不支持的数据库类型".into()),
    }
}

fn run_alter_table(
    profile: &SqlProfile,
    database: String,
    table: String,
    adds: Vec<SqlColumnDef>,
    drops: Vec<String>,
    modifies: Vec<SqlColumnChange>,
) -> Result<u64, String> {
    let table = table.trim().to_string();
    if table.is_empty() { return Err("表名不能为空".into()); }
    let quoted = quote_ident(&profile.kind, &table);
    let mut statements: Vec<String> = Vec::new();
    match profile.kind.as_str() {
        "mysql" => {
            for def in &adds {
                statements.push(format!("ALTER TABLE {quoted} ADD COLUMN {}", mysql_column_ddl(def)));
            }
            for name in &drops {
                statements.push(format!("ALTER TABLE {quoted} DROP COLUMN {}", quote_ident("mysql", name)));
            }
            for change in &modifies {
                statements.push(format!("ALTER TABLE {quoted} MODIFY COLUMN {}", mysql_column_ddl(&change.def)));
            }
        }
        "postgres" => {
            for def in &adds {
                statements.push(format!("ALTER TABLE {quoted} ADD COLUMN {}", pg_column_ddl(def)));
            }
            for name in &drops {
                statements.push(format!("ALTER TABLE {quoted} DROP COLUMN IF EXISTS {}", quote_ident("postgres", name)));
            }
            for change in &modifies {
                let def = &change.def;
                let col = quote_ident("postgres", &def.name);
                if let Some(old) = &change.old_name {
                    if old != &def.name {
                        statements.push(format!("ALTER TABLE {quoted} RENAME COLUMN {} TO {}", quote_ident("postgres", old), col));
                    }
                }
                if !def.auto_increment {
                    statements.push(format!("ALTER TABLE {quoted} ALTER COLUMN {col} TYPE {}", column_type("postgres", def)));
                }
                if def.nullable {
                    statements.push(format!("ALTER TABLE {quoted} ALTER COLUMN {col} DROP NOT NULL"));
                } else {
                    statements.push(format!("ALTER TABLE {quoted} ALTER COLUMN {col} SET NOT NULL"));
                }
                match &def.default {
                    Some(value) => statements.push(format!("ALTER TABLE {quoted} ALTER COLUMN {col} SET DEFAULT {}", default_literal(value))),
                    None => statements.push(format!("ALTER TABLE {quoted} ALTER COLUMN {col} DROP DEFAULT")),
                }
            }
        }
        "sqlite" => {
            if !modifies.is_empty() {
                return Err("SQLite 不支持直接修改已有字段，请删除后重新添加该字段".into());
            }
            for def in &adds {
                if def.primary_key || def.auto_increment {
                    return Err("SQLite 的 ADD COLUMN 不支持主键或自增字段，请直接在新表设计中创建".into());
                }
                statements.push(format!("ALTER TABLE {quoted} ADD COLUMN {}", sqlite_column_ddl(def)));
            }
            for name in &drops {
                statements.push(format!("ALTER TABLE {quoted} DROP COLUMN {}", quote_ident("sqlite", name)));
            }
        }
        other => return Err(format!("不支持的数据库类型：{other}")),
    }
    if statements.is_empty() { return Ok(0); }
    match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            let mut conn = open_mysql(profile, Some(&database))?;
            for sql in &statements {
                conn.query_drop(sql).map_err(|error| format!("更新表结构失败：{error}（SQL：{sql}）"))?;
            }
            Ok(statements.len() as u64)
        }
        "postgres" => {
            let mut client = pg_client(profile, Some(&database))?;
            client.batch_execute(&statements.join("\n")).map_err(|error| format!("更新表结构失败：{error}"))?;
            Ok(statements.len() as u64)
        }
        "sqlite" => {
            let conn = sqlite_take(profile)?;
            let result = conn.execute_batch(&statements.join("\n")).map_err(|error| format!("更新表结构失败：{error}"));
            sqlite_put(profile, conn);
            result.map(|_| statements.len() as u64)
        }
        _ => Err("不支持的数据库类型".into()),
    }
}

#[tauri::command]
pub async fn sql_create_table(profile: SqlProfile, database: String, table: String, columns: Vec<SqlColumnDef>) -> Result<u64, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_create_table(&profile, database, table, columns));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(30), task).await.map_err(|_| "建表超过 30 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_alter_table(profile: SqlProfile, database: String, table: String, adds: Vec<SqlColumnDef>, drops: Vec<String>, modifies: Vec<SqlColumnChange>) -> Result<u64, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_alter_table(&profile, database, table, adds, drops, modifies));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(30), task).await.map_err(|_| "更新表结构超过 30 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub fn sql_disconnect(profile: SqlProfile) -> Result<(), String> {
    // 断开 = 关闭并移除该配置的缓存连接（SQLite/MySQL/PostgreSQL）
    if let Ok(mut cache) = conn_cache().lock() {
        cache.remove(&sql_cache_key(&profile, None));
    }
    Ok(())
}

#[tauri::command]
pub async fn sql_databases(profile: SqlProfile) -> Result<Vec<String>, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_databases(&profile));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task).await.map_err(|_| "查询数据库超过 15 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_tables(profile: SqlProfile, database: String) -> Result<Vec<SqlTableInfo>, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_tables(&profile, database));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task).await.map_err(|_| "查询表超过 15 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_table_columns(profile: SqlProfile, database: String, table: String) -> Result<Vec<SqlColumnInfo>, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_columns(&profile, database, table));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task).await.map_err(|_| "查询字段超过 15 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_table_rows(
    profile: SqlProfile,
    database: String,
    table: String,
    offset: u64,
    limit: u64,
    filter: Option<String>,
) -> Result<SqlRowsResult, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_rows(&profile, database, table, offset, limit.min(1000), filter));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(30), task).await.map_err(|_| "查询数据超过 30 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_update_row(profile: SqlProfile, database: String, table: String, keys: Vec<SqlCellRef>, changes: Vec<SqlCellRef>) -> Result<u64, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_update_row(&profile, database, table, keys, changes));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(30), task).await.map_err(|_| "更新数据超过 30 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_insert_row(profile: SqlProfile, database: String, table: String, columns: Vec<String>, values: Vec<Option<String>>) -> Result<u64, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_insert_row(&profile, database, table, columns, values));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(30), task).await.map_err(|_| "插入数据超过 30 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_delete_rows(profile: SqlProfile, database: String, table: String, key_column: String, key_values: Vec<String>) -> Result<u64, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_delete_rows(&profile, database, table, key_column, key_values));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(30), task).await.map_err(|_| "删除数据超过 30 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_table_ddl(profile: SqlProfile, database: String, table: String) -> Result<String, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_table_ddl(&profile, database, table));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task).await.map_err(|_| "查询建表语句超过 15 秒未返回，已超时；操作可能仍在后台执行，请确认结果后再重复操作".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}
