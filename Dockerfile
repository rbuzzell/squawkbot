# Container image that runs your code
FROM rust:latest
# Copies your code file from your action repository to the filesystem path `/` of the container
COPY src/entrypoint.sh /entrypoint.sh
COPY target/release/squawkbot /opt/bot_stuff/squawkbot

# Code file to execute when the docker container starts up (`entrypoint.sh`)
ENTRYPOINT ["/entrypoint.sh"]
