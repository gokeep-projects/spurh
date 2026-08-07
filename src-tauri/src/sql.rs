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
    let mut rest = sql;
    // ???????/* ... */?????-- ??????????# ????MySQL?
    loop {
        rest = rest.trim_start();
        if let Some(inner) = rest.strip_prefix("/*") {
            let Some(end) = inner.find("*/") else { return String::new() };
            rest = &inner[end + 2..];
        } else if let Some(inner) = rest.strip_prefix("--") {
            let Some(end) = inner.find('\n') else { return String::new() };
            rest = &inner[end + 1..];
        } else if let Some(inner) = rest.strip_prefix('#') {
            let Some(end) = inner.find('\n') else { return String::new() };
            rest = &inner[end + 1..];
        } else {
            break;
        }
    }
    let mut keyword = String::new();
    for ch in rest.chars() {
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
    text.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_type_maps_dialect_and_cleans_unknown() {
        let col = |ty: &str, length: Option<u32>| SqlColumnDef {
            name: "c".into(), data_type: ty.into(), length, nullable: true, default: None, primary_key: false, auto_increment: false, comment: None,
        };
        assert_eq!(column_type("mysql", &col("INT", None)), "INT");
        assert_eq!(column_type("mysql", &col("varchar", Some(255))), "VARCHAR(255)");
        assert_eq!(column_type("mysql", &col("TEXT", None)), "TEXT");
        assert_eq!(column_type("postgres", &col("INTEGER", None)), "INTEGER");
        assert_eq!(column_type("postgres", &col("double precision", None)), "DOUBLE PRECISION");
        assert_eq!(column_type("sqlite", &col("BLOB", None)), "BLOB");
        // 未知类型清洗后回退，不引入任意 SQL
        assert_eq!(column_type("mysql", &col("evil; DROP TABLE x", None)), "EVILDROPTABLEX");
        assert_eq!(column_type("sqlite", &col("", None)), "TEXT");
    }

    #[test]
    fn default_literal_keeps_keywords_escapes_text() {
        assert_eq!(default_literal("CURRENT_TIMESTAMP"), "CURRENT_TIMESTAMP");
        assert_eq!(default_literal("NOW()"), "NOW()");
        assert_eq!(default_literal("TRUE"), "TRUE");
        assert_eq!(default_literal("0.5"), "0.5");
        assert_eq!(default_literal("-1"), "-1");
        assert_eq!(default_literal("null"), "NULL");
        assert_eq!(default_literal(""), "NULL");
        assert_eq!(default_literal("hello"), "'hello'");
        assert_eq!(default_literal("it's"), "'it''s'");
    }

    #[test]
    fn mysql_value_literal_escapes_quotes_and_backslashes() {
        use mysql::Value;
        assert_eq!(mysql_value_literal(&Value::NULL), "NULL");
        assert_eq!(mysql_value_literal(&Value::Int(42)), "42");
        assert_eq!(mysql_value_literal(&Value::Bytes(b"a'b\\c".to_vec())), "'a''b\\\\c'");
    }

    #[test]
    fn first_keyword_uppercases_and_skips_leading_noise() {
        assert_eq!(first_keyword("select * from users"), "SELECT");
        assert_eq!(first_keyword("  explain analyze select 1"), "EXPLAIN");
        assert_eq!(first_keyword("/* comment */ select 1"), "SELECT");
        assert_eq!(first_keyword("-- ??\nselect 1"), "SELECT");
        assert_eq!(first_keyword("# MySQL ??\nupdate t set a = 1"), "UPDATE");
        assert_eq!(first_keyword("/* ??\n?? */\n  with x as (select 1) select * from x"), "WITH");
        assert_eq!(first_keyword("/* ???"), "");
        assert_eq!(first_keyword("select"), "SELECT");
        assert_eq!(first_keyword(";"), "");
        assert_eq!(first_keyword("with x as (select 1) select * from x"), "WITH");
    }

    #[test]
    fn is_query_sql_classifies_read_only_statements() {
        assert!(is_query_sql("select 1"));
        assert!(is_query_sql("SHOW TABLES"));
        assert!(is_query_sql("describe users"));
        assert!(is_query_sql("PRAGMA table_info(t)"));
        assert!(!is_query_sql("insert into t values (1)"));
        assert!(!is_query_sql("update t set a = 1"));
        assert!(!is_query_sql("delete from t"));
    }

    #[test]
    fn quote_ident_escapes_and_chooses_dialect() {
        assert_eq!(quote_ident("mysql", "users"), "`users`");
        assert_eq!(quote_ident("mysql", "a`b"), "`a``b`");
        assert_eq!(quote_ident("postgres", "users"), "\"users\"");
        assert_eq!(quote_ident("sqlite", "a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_ident("unknown", "t"), "\"t\"");
    }

    #[test]
    fn sanitize_comment_flattens_newlines() {
        assert_eq!(sanitize_comment("line1\r\nline2\nline3"), "line1 line2 line3");
        assert_eq!(sanitize_comment("single"), "single");
    }

    use std::sync::atomic::{AtomicU32, Ordering};

    static SQL_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn sqlite_profile() -> SqlProfile {
        let id = SQL_COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("spurh-sql-{}-{id}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        SqlProfile {
            kind: "sqlite".into(),
            host: String::new(),
            port: None,
            user: None,
            password: None,
            database: None,
            file: Some(path.to_string_lossy().into_owned()),
            ssl: false,
        }
    }

    fn cleanup(profile: &SqlProfile) {
        // 取出缓存的连接并关闭，释放 Windows 文件句柄后删除临时库
        drop(conn_take(profile, None));
        if let Some(path) = profile.file.as_deref() {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn sqlite_query_and_dml_roundtrip() {
        let profile = sqlite_profile();
        let setup = sqlite_exec(&profile, "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, score INTEGER); INSERT INTO users (name, score) VALUES ('alice', 90), ('bob', 80), ('carol', 70);", 500).unwrap();
        assert!(!setup.is_query, "DDL/INSERT 应为非查询");

        let query = sqlite_exec(&profile, "SELECT id, name, score FROM users ORDER BY id", 500).unwrap();
        assert!(query.is_query);
        assert_eq!(query.columns, vec!["id", "name", "score"]);
        assert_eq!(query.rows.len(), 3);
        assert_eq!(query.rows[0], vec![serde_json::json!(1), serde_json::json!("alice"), serde_json::json!(90)]);
        assert!(!query.truncated);

        let update = sqlite_exec(&profile, "UPDATE users SET score = score + 5 WHERE name = 'bob'", 500).unwrap();
        assert!(!update.is_query);
        assert_eq!(update.affected, 1, "UPDATE 应返回受影响行数");
        let check = sqlite_exec(&profile, "SELECT score FROM users WHERE name = 'bob'", 500).unwrap();
        assert_eq!(check.rows[0][0], serde_json::json!(85));

        let deleted = sqlite_exec(&profile, "DELETE FROM users WHERE score < 75", 500).unwrap();
        assert!(!deleted.is_query);
        assert_eq!(deleted.affected, 1);

        let count = sqlite_exec(&profile, "SELECT COUNT(*) FROM users", 500).unwrap();
        assert_eq!(count.rows[0][0], serde_json::json!(2));
        cleanup(&profile);
    }

    #[test]
    fn sqlite_multistatement_batch_and_errors() {
        let profile = sqlite_profile();
        sqlite_exec(&profile, "CREATE TABLE t (v TEXT)", 500).unwrap();
        let batch = sqlite_exec(&profile, "INSERT INTO t VALUES ('a'); INSERT INTO t VALUES ('b'); INSERT INTO t VALUES ('c');", 500).unwrap();
        assert!(!batch.is_query);
        let count = sqlite_exec(&profile, "SELECT COUNT(*) FROM t", 500).unwrap();
        assert_eq!(count.rows[0][0], serde_json::json!(3));

        let err = sqlite_exec(&profile, "SELEC 1", 500).unwrap_err();
        assert!(err.contains("SQL"), "错误应包含 SQL 提示：{err}");

        // 带前导注释的 SELECT 应被识别为查询（回退 first_keyword 修复）
        let commented = sqlite_exec(&profile, "/* 注释 */ SELECT COUNT(*) FROM t", 500).unwrap();
        assert!(commented.is_query);
        assert_eq!(commented.rows[0][0], serde_json::json!(3));
        cleanup(&profile);
    }

    #[test]
    fn sqlite_truncates_at_max_rows() {
        let profile = sqlite_profile();
        let setup = "CREATE TABLE big (n INTEGER); INSERT INTO big (n) VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9), (10);";
        sqlite_exec(&profile, setup, 500).unwrap();
        let result = sqlite_exec(&profile, "SELECT n FROM big ORDER BY n", 4).unwrap();
        assert!(result.truncated);
        assert_eq!(result.rows.len(), 4);
        cleanup(&profile);
    }
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

/* ── 用户管理与权限（MySQL / PostgreSQL；SQLite 无用户概念） ── */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlUserInfo {
    pub name: String,
    pub host: Option<String>,
    pub attributes: Vec<SqlUserAttr>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlUserAttr {
    pub key: String,
    pub value: String,
}

/// 校验用户名：仅字母 / 数字 / 下划线 / $，最长 32 字符（与 MySQL 一致）
fn valid_user_ident(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn valid_mysql_host(host: &str) -> bool {
    !host.is_empty() && host.len() <= 64 && host.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:%".contains(c))
}

/// 字符串字面量：转义单引号（PG 双写引号；MySQL 同时转义反斜杠）
fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

const GRANTABLE_PRIVS: [&str; 7] = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALL PRIVILEGES"];

pub fn build_create_user_sql(kind: &str, name: &str, host: &str, password: &str) -> Result<String, String> {
    if !valid_user_ident(name) { return Err("用户名只能包含字母、数字、下划线和 $，最长 32 字符".into()); }
    match kind {
        "mysql" => {
            if !valid_mysql_host(host) { return Err("MySQL 主机只能包含字母、数字、. - _ : %".into()); }
            Ok(format!("CREATE USER {}@{} IDENTIFIED BY {}", quote_ident("mysql", name), sql_literal(host), sql_literal(password)))
        }
        "postgres" => Ok(format!("CREATE ROLE {} LOGIN PASSWORD {}", quote_ident("postgres", name), sql_literal(password))),
        _ => Err("SQLite 不包含用户概念，无需用户管理".into()),
    }
}

pub fn build_drop_user_sql(kind: &str, name: &str, host: &str) -> Result<String, String> {
    if !valid_user_ident(name) { return Err("非法的用户名".into()); }
    match kind {
        "mysql" => {
            if !valid_mysql_host(host) { return Err("MySQL 主机只能包含字母、数字、. - _ : %".into()); }
            Ok(format!("DROP USER {}@{}", quote_ident("mysql", name), sql_literal(host)))
        }
        "postgres" => Ok(format!("DROP ROLE {}", quote_ident("postgres", name))),
        _ => Err("SQLite 不包含用户概念，无需用户管理".into()),
    }
}

pub fn build_set_password_sql(kind: &str, name: &str, host: &str, password: &str) -> Result<String, String> {
    if !valid_user_ident(name) { return Err("非法的用户名".into()); }
    match kind {
        "mysql" => {
            if !valid_mysql_host(host) { return Err("MySQL 主机只能包含字母、数字、. - _ : %".into()); }
            Ok(format!("ALTER USER {}@{} IDENTIFIED BY {}", quote_ident("mysql", name), sql_literal(host), sql_literal(password)))
        }
        "postgres" => Ok(format!("ALTER ROLE {} WITH PASSWORD {}", quote_ident("postgres", name), sql_literal(password))),
        _ => Err("SQLite 不包含用户概念，无需用户管理".into()),
    }
}

/// 生成授权 / 回收语句。database 为空表示全部库（MySQL `*.*`；PG 使用 public schema）。
pub fn build_grant_sql(kind: &str, name: &str, host: &str, database: &str, privileges: &[String], grant: bool) -> Result<Vec<String>, String> {
    if !valid_user_ident(name) { return Err("非法的用户名".into()); }
    for priv_name in privileges {
        if !GRANTABLE_PRIVS.contains(&priv_name.as_str()) {
            return Err(format!("不支持的权限：{priv_name}"));
        }
    }
    if privileges.is_empty() { return Ok(vec![]); }
    let mut out = Vec::new();
    match kind {
        "mysql" => {
            if !valid_mysql_host(host) { return Err("MySQL 主机只能包含字母、数字、. - _ : %".into()); }
            let db = if database.trim().is_empty() || database == "*" { "*".to_string() } else { quote_ident("mysql", database) };
            let target = format!("{}@{}", quote_ident("mysql", name), sql_literal(host));
            let op = if grant { "GRANT" } else { "REVOKE" };
            let to_from = if grant { "TO" } else { "FROM" };
            for priv_name in privileges {
                out.push(format!("{op} {priv_name} ON {db}.* {to_from} {target}"));
            }
        }
        "postgres" => {
            let role = quote_ident("postgres", name);
            if grant {
                out.push(format!("GRANT USAGE ON SCHEMA public TO {role}"));
            }
            let op = if grant { "GRANT" } else { "REVOKE" };
            let to_from = if grant { "TO" } else { "FROM" };
            for priv_name in privileges {
                let priv_name = if priv_name == "ALL PRIVILEGES" { "ALL" } else { priv_name.as_str() };
                out.push(format!("{op} {priv_name} ON ALL TABLES IN SCHEMA public {to_from} {role}"));
            }
        }
        _ => return Err("SQLite 不包含用户概念，无需用户管理".into()),
    }
    Ok(out)
}

fn run_users(profile: &SqlProfile) -> Result<Vec<SqlUserInfo>, String> {
    match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, None, |conn| {
                let rows: Vec<(String, String, String, String, String)> = conn
                    .exec("SELECT user, host, plugin, account_locked, password_expired FROM mysql.user ORDER BY user, host", ())
                    .map_err(|error| format!("读取用户列表失败：{error}（当前账号可能需要 mysql.user 表权限）"))?;
                Ok(rows.into_iter().map(|(name, host, plugin, locked, expired)| SqlUserInfo {
                    name,
                    host: Some(host),
                    attributes: vec![
                        SqlUserAttr { key: "认证插件".into(), value: plugin },
                        SqlUserAttr { key: "账号锁定".into(), value: if locked == "Y" { "是".into() } else { "否".into() } },
                        SqlUserAttr { key: "密码过期".into(), value: if expired == "Y" { "是".into() } else { "否".into() } },
                    ],
                }).collect())
            })
        }
        "postgres" => {
            with_pg(profile, None, |client| {
                let rows = client
                    .query("SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolconnlimit, rolreplication FROM pg_roles ORDER BY rolname", &[])
                    .map_err(|error| format!("读取角色列表失败：{error}"))?;
                Ok(rows.iter().map(|row| {
                    let name: String = row.get(0);
                    let attributes = vec![
                        SqlUserAttr { key: "超级用户".into(), value: if row.get::<_, bool>(1) { "是" } else { "否" }.into() },
                        SqlUserAttr { key: "可登录".into(), value: if row.get::<_, bool>(5) { "是" } else { "否" }.into() },
                        SqlUserAttr { key: "可建角色".into(), value: if row.get::<_, bool>(3) { "是" } else { "否" }.into() },
                        SqlUserAttr { key: "可建库".into(), value: if row.get::<_, bool>(4) { "是" } else { "否" }.into() },
                        SqlUserAttr { key: "连接数限制".into(), value: row.get::<_, i64>(6).to_string() },
                    ];
                    SqlUserInfo { name, host: None, attributes }
                }).collect())
            })
        }
        _ => Ok(vec![]),
    }
}

fn run_user_grants(profile: &SqlProfile, name: &str, host: Option<&str>) -> Result<Vec<String>, String> {
    if !valid_user_ident(name) { return Err("非法的用户名".into()); }
    match profile.kind.as_str() {
        "mysql" => {
            use mysql::prelude::*;
            with_mysql(profile, None, |conn| {
                let target = format!("{}@{}", quote_ident("mysql", name), sql_literal(host.unwrap_or("%")));
                let rows: Vec<String> = conn
                    .exec(format!("SHOW GRANTS FOR {target}"), ())
                    .map_err(|error| format!("读取 {name} 的权限失败：{error}（当前账号可能缺少 SHOW GRANTS 权限）"))?;
                Ok(rows)
            })
        }
        "postgres" => {
            with_pg(profile, None, |client| {
                let mut lines = Vec::new();
                let table_rows = client
                    .query("SELECT privilege_type, table_schema, table_name FROM information_schema.role_table_grants WHERE grantee = $1 ORDER BY table_schema, table_name, privilege_type", &[&name])
                    .map_err(|error| format!("读取 {name} 的表权限失败：{error}"))?;
                for row in table_rows {
                    let priv_name: String = row.get(0);
                    let schema: String = row.get(1);
                    let table: String = row.get(2);
                    lines.push(format!("GRANT {priv_name} ON {schema}.{table} TO {name}"));
                }
                let usage_rows = client
                    .query("SELECT privilege_type, table_schema FROM information_schema.role_usage_grants WHERE grantee = $1 ORDER BY table_schema", &[&name])
                    .map_err(|error| format!("读取 {name} 的 schema 权限失败：{error}"))?;
                for row in usage_rows {
                    let priv_name: String = row.get(0);
                    let schema: String = row.get(1);
                    lines.push(format!("GRANT {priv_name} ON SCHEMA {schema} TO {name}"));
                }
                Ok(lines)
            })
        }
        _ => Ok(vec![]),
    }
}

fn run_statements(profile: &SqlProfile, statements: Vec<String>) -> Result<Vec<String>, String> {
    let mut executed = Vec::new();
    for stmt in statements {
        run_sql(profile, &stmt)?;
        executed.push(stmt);
    }
    Ok(executed)
}

#[tauri::command]
pub async fn sql_users(profile: SqlProfile) -> Result<Vec<SqlUserInfo>, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_users(&profile));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task).await.map_err(|_| "读取用户列表超过 15 秒未返回，已超时".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_user_grants(profile: SqlProfile, name: String, host: Option<String>) -> Result<Vec<String>, String> {
    let task = tauri::async_runtime::spawn_blocking(move || run_user_grants(&profile, &name, host.as_deref()));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task).await.map_err(|_| "读取权限超过 15 秒未返回，已超时".to_string())?;
    joined.map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub async fn sql_create_user(profile: SqlProfile, name: String, host: String, password: String) -> Result<String, String> {
    let stmt = build_create_user_sql(&profile.kind, &name, &host, &password)?;
    let sql = stmt.clone();
    let task = tauri::async_runtime::spawn_blocking(move || run_sql(&profile, &sql));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task).await.map_err(|_| "创建用户超过 15 秒未返回，已超时".to_string())?;
    let _ = joined.map_err(|error| format!("创建用户失败：{error}"))?;
    Ok(stmt)
}

#[tauri::command]
pub async fn sql_drop_user(profile: SqlProfile, name: String, host: String) -> Result<String, String> {
    let stmt = build_drop_user_sql(&profile.kind, &name, &host)?;
    let sql = stmt.clone();
    let task = tauri::async_runtime::spawn_blocking(move || run_sql(&profile, &sql));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task).await.map_err(|_| "删除用户超过 15 秒未返回，已超时".to_string())?;
    let _ = joined.map_err(|error| format!("删除用户失败：{error}"))?;
    Ok(stmt)
}

#[tauri::command]
pub async fn sql_set_password(profile: SqlProfile, name: String, host: String, password: String) -> Result<String, String> {
    let stmt = build_set_password_sql(&profile.kind, &name, &host, &password)?;
    let sql = stmt.clone();
    let task = tauri::async_runtime::spawn_blocking(move || run_sql(&profile, &sql));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(15), task).await.map_err(|_| "修改密码超过 15 秒未返回，已超时".to_string())?;
    let _ = joined.map_err(|error| format!("修改密码失败：{error}"))?;
    Ok(stmt)
}

#[tauri::command]
pub async fn sql_grant_privileges(
    profile: SqlProfile,
    name: String,
    host: String,
    database: String,
    privileges: Vec<String>,
    grant: bool,
) -> Result<Vec<String>, String> {
    let statements = build_grant_sql(&profile.kind, &name, &host, &database, &privileges, grant)?;
    if statements.is_empty() { return Ok(vec![]); }
    let sql_list = statements.clone();
    let task = tauri::async_runtime::spawn_blocking(move || run_statements(&profile, sql_list));
    let joined = tokio::time::timeout(std::time::Duration::from_secs(30), task).await.map_err(|_| "授权操作超过 30 秒未返回，已超时".to_string())?;
    joined.map_err(|error| format!("授权操作失败：{error}"))?
}

#[cfg(test)]
mod user_tests {
    use super::*;

    fn v(list: &[&str]) -> Vec<String> { list.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn create_user_sql_dialects_and_validation() {
        assert_eq!(build_create_user_sql("mysql", "alice", "%", "s3cret").unwrap(), "CREATE USER `alice`@'%' IDENTIFIED BY 's3cret'");
        assert_eq!(build_create_user_sql("mysql", "alice", "localhost", "it's").unwrap(), "CREATE USER `alice`@'localhost' IDENTIFIED BY 'it''s'");
        assert_eq!(build_create_user_sql("postgres", "alice", "", "p@ss").unwrap(), "CREATE ROLE \"alice\" LOGIN PASSWORD 'p@ss'");
        assert!(build_create_user_sql("mysql", "bad;name", "%", "x").is_err());
        assert!(build_create_user_sql("mysql", "alice", "bad host", "x").is_err());
        assert!(build_create_user_sql("sqlite", "alice", "%", "x").is_err());
        assert!(build_create_user_sql("mysql", "", "%", "x").is_err());
        assert_eq!(build_create_user_sql("mysql", "a_b$1", "10.0.0.1", "x").unwrap(), "CREATE USER `a_b$1`@'10.0.0.1' IDENTIFIED BY 'x'");
    }

    #[test]
    fn drop_and_password_sql() {
        assert_eq!(build_drop_user_sql("mysql", "bob", "%").unwrap(), "DROP USER `bob`@'%'");
        assert_eq!(build_drop_user_sql("postgres", "bob", "").unwrap(), "DROP ROLE \"bob\"");
        assert_eq!(build_set_password_sql("mysql", "bob", "%", "n3w").unwrap(), "ALTER USER `bob`@'%' IDENTIFIED BY 'n3w'");
        assert_eq!(build_set_password_sql("postgres", "bob", "", "n3w").unwrap(), "ALTER ROLE \"bob\" WITH PASSWORD 'n3w'");
    }

    #[test]
    fn grant_sql_mysql_and_pg() {
        let g = build_grant_sql("mysql", "alice", "%", "app", &v(&["SELECT", "INSERT"]), true).unwrap();
        assert_eq!(g, vec!["GRANT SELECT ON `app`.* TO `alice`@'%'", "GRANT INSERT ON `app`.* TO `alice`@'%'"]);
        let r = build_grant_sql("mysql", "alice", "%", "", &v(&["SELECT"]), false).unwrap();
        assert_eq!(r, vec!["REVOKE SELECT ON *.* FROM `alice`@'%'"]);
        let p = build_grant_sql("postgres", "alice", "", "app", &v(&["SELECT", "ALL PRIVILEGES"]), true).unwrap();
        assert_eq!(p, vec![
            "GRANT USAGE ON SCHEMA public TO \"alice\"",
            "GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"alice\"",
            "GRANT ALL ON ALL TABLES IN SCHEMA public TO \"alice\"",
        ]);
        assert!(build_grant_sql("mysql", "alice", "%", "app", &v(&["SUPER"]), true).is_err());
        assert!(build_grant_sql("sqlite", "alice", "%", "app", &v(&["SELECT"]), true).is_err());
    }
}
