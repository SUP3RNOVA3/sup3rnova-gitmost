import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsNotEmpty()
  @IsString()
  password: string;

  // When true, the access token is returned in the response body (in addition
  // to the httpOnly cookie) so native/mobile clients can store it in
  // Keychain/Keystore and send it as 'Authorization: Bearer'. Web clients omit
  // this flag and keep using the cookie. Opt-in only: the token is never put in
  // the body otherwise.
  @IsOptional()
  @IsBoolean()
  returnToken?: boolean;
}
